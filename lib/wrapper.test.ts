// End-to-end exercise of the materialized coalescer: spawn the ACTUAL wrapper
// script with scripted fake agents behind it and assert on the emitted wire
// lines. The wrapper is load-bearing infrastructure that runs outside the
// plugin (materialized onto hosts), so testing the embedded string via a real
// spawn is the only test that covers what ships.
//
// Timing model: the throttle window in every test is 200ms (KIMI_COALESCE_MS),
// and assertions that depend on time use generous multiples of it, so a slow
// CI machine skews margins, not outcomes.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterAll, describe, expect, it } from "vitest";

import {
  LAUNCH_SNIPPET,
  WRAPPER_HOME_RELATIVE_PATH,
  materializeWrapper,
} from "./wrapper";

const scratch = mkdtempSync(join(tmpdir(), "kimi-coalesce-"));
const wrapper = materializeWrapper(scratch);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const THROTTLE_MS = 200;

// --- wire-message builders ---------------------------------------------------

function toolUpdate(options: {
  session?: string;
  tool?: string;
  status?: string;
  text?: string;
  extra?: Record<string, unknown>;
}): string {
  const update: Record<string, unknown> = {
    sessionUpdate: "tool_call_update",
    toolCallId: options.tool ?? "t1",
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.text === undefined
      ? {}
      : { content: [{ type: "content", content: { type: "text", text: options.text } }] }),
    ...options.extra,
  };
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: options.session ?? "s1", update },
  });
}

function chunk(text: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
}

function thought(text: string, session = "s1"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: session,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } },
    },
  });
}

const RESPONSE = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
const PERMISSION_REQUEST = JSON.stringify({
  jsonrpc: "2.0",
  id: 7,
  method: "session/request_permission",
  params: { sessionId: "s1", toolCall: { toolCallId: "t1" } },
});

// --- harness -----------------------------------------------------------------

let agentCounter = 0;

/**
 * A fake agent from an arbitrary JS body. `emit(line)` writes one wire line;
 * `sleep(ms)` awaits; the body runs inside an async IIFE.
 */
function writeAgent(body: string): string {
  const path = join(scratch, `fake-agent-${agentCounter++}.mjs`);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const emit = (line) => process.stdout.write(line + "\\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await (async () => {
${body}
})();
`,
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

/** A fake agent that just prints a fixed list of lines and exits. */
function writeEmittingAgent(lines: string[]): string {
  return writeAgent(`for (const line of ${JSON.stringify(lines)}) emit(line);`);
}

interface WrapperRun {
  code: number | null;
  signal: string | null;
  /** Parsed stdout lines with arrival times relative to spawn. */
  lines: { raw: string; atMs: number }[];
  stderr: string;
}

interface RunOptions {
  env?: Record<string, string>;
  stdinLines?: string[];
  /** Called once per stdout line while the wrapper runs (e.g. to send signals). */
  onLine?: (raw: string, child: ReturnType<typeof spawn>) => void;
  timeoutMs?: number;
}

function runWrapper(agent: string, options: RunOptions = {}): Promise<WrapperRun> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [wrapper, "acp"], {
      env: {
        ...process.env,
        KIMI_ACP_REAL: agent,
        KIMI_COALESCE_MS: String(THROTTLE_MS),
        ...options.env,
      },
    });
    const lines: WrapperRun["lines"] = [];
    let stdoutBuffer = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`wrapper did not exit; stdout so far:\n${stdoutBuffer}`));
    }, options.timeoutMs ?? 15_000);

    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString("utf8");
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
        const raw = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (raw.length === 0) continue;
        lines.push({ raw, atMs: Date.now() - startedAt });
        options.onLine?.(raw, child);
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      // Give the last stdout flush a beat to arrive before resolving.
      setTimeout(() => {
        clearTimeout(timeout);
        resolve({ code, signal, lines, stderr });
      }, 50);
    });

    for (const line of options.stdinLines ?? []) child.stdin.write(`${line}\n`);
    if (options.stdinLines !== undefined) child.stdin.end();
  });
}

function parsed(run: WrapperRun): Record<string, any>[] {
  return run.lines.map((line) => JSON.parse(line.raw) as Record<string, any>);
}

function toolUpdatesOf(messages: Record<string, any>[]): Record<string, any>[] {
  return messages.filter(
    (message) => message.params?.update?.sessionUpdate === "tool_call_update",
  );
}

function textOf(update: Record<string, any>): string | undefined {
  return update.params.update.content?.[0]?.content?.text;
}

function thoughtChunksOf(messages: Record<string, any>[]): Record<string, any>[] {
  return messages.filter(
    (message) => message.params?.update?.sessionUpdate === "agent_thought_chunk",
  );
}

function thoughtTextOf(update: Record<string, any>): string {
  return update.params.update.content.text as string;
}

// --- coalescing behavior -----------------------------------------------------

describe("coalescing", () => {
  it("collapses a progress burst into leading + merged + terminal, preserving order", async () => {
    const burst = Array.from({ length: 40 }, (_, i) =>
      toolUpdate({ status: "in_progress", text: `tick ${i + 1}` }),
    );
    const agent = writeEmittingAgent([
      RESPONSE,
      ...burst,
      chunk("hello"),
      toolUpdate({ status: "completed" }),
    ]);
    const run = await runWrapper(agent);
    expect(run.code).toBe(0);

    const messages = parsed(run);
    expect(messages[0]).toEqual(JSON.parse(RESPONSE));

    const updates = toolUpdatesOf(messages);
    expect(updates).toHaveLength(3);
    expect(textOf(updates[0]!)).toBe("tick 1");
    expect(textOf(updates[1]!)).toBe("tick 40");
    expect(updates[2]!.params.update.status).toBe("completed");

    // The message chunk flushed the held burst before itself: order holds.
    const chunkIndex = messages.findIndex(
      (message) => message.params?.update?.sessionUpdate === "agent_message_chunk",
    );
    expect(chunkIndex).toBe(3); // response, tick 1, tick 40, chunk, completed
    expect(messages).toHaveLength(5);
  });

  it("coalesces per tool call: interleaved bursts stay independent and complete", async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 20; i++) {
      lines.push(toolUpdate({ tool: "t1", status: "in_progress", text: `a${i}` }));
      lines.push(toolUpdate({ tool: "t2", status: "in_progress", text: `b${i}` }));
    }
    lines.push(toolUpdate({ tool: "t1", status: "completed" }));
    lines.push(toolUpdate({ tool: "t2", status: "failed" }));
    const run = await runWrapper(writeEmittingAgent(lines));
    expect(run.code).toBe(0);

    const byTool = (tool: string) =>
      toolUpdatesOf(parsed(run)).filter((u) => u.params.update.toolCallId === tool);
    // Per key: the leading edge, then the terminal merged with the held burst.
    const t1 = byTool("t1");
    expect(t1).toHaveLength(2);
    expect(textOf(t1[0]!)).toBe("a1");
    expect(textOf(t1[1]!)).toBe("a20");
    expect(t1[1]!.params.update.status).toBe("completed");

    const t2 = byTool("t2");
    expect(t2).toHaveLength(2);
    expect(textOf(t2[1]!)).toBe("b20");
    expect(t2[1]!.params.update.status).toBe("failed");
  });

  it("keys on session AND tool call id", async () => {
    const run = await runWrapper(
      writeEmittingAgent([
        toolUpdate({ session: "s1", tool: "t1", status: "in_progress", text: "s1 first" }),
        toolUpdate({ session: "s2", tool: "t1", status: "in_progress", text: "s2 first" }),
      ]),
    );
    // Same toolCallId in different sessions: both are leading edges.
    expect(toolUpdatesOf(parsed(run)).map(textOf)).toEqual(["s1 first", "s2 first"]);
  });

  it("merges as a field union, newest value winning per field", async () => {
    const run = await runWrapper(
      writeEmittingAgent([
        toolUpdate({ status: "in_progress", text: "lead" }),
        toolUpdate({ status: "in_progress", text: "newer text" }),
        toolUpdate({ extra: { rawOutput: { stdout: "xyz" } } }), // no content, no status
        toolUpdate({ status: "completed" }),
      ]),
    );
    const updates = toolUpdatesOf(parsed(run));
    expect(updates).toHaveLength(2);
    const final = updates[1]!.params.update;
    // Every field that ever appeared survives; each holds its newest value.
    expect(final.status).toBe("completed");
    expect(final.rawOutput).toEqual({ stdout: "xyz" });
    expect(textOf(updates[1]!)).toBe("newer text");
  });

  it("flushes a held snapshot on the trailing edge when the stream goes quiet", async () => {
    const agent = writeAgent(`
      emit(${JSON.stringify(toolUpdate({ status: "in_progress", text: "lead" }))});
      for (let i = 1; i <= 5; i++)
        emit(${JSON.stringify(toolUpdate({ status: "in_progress", text: "held" }))});
      await sleep(${THROTTLE_MS * 4});
      emit(${JSON.stringify(chunk("late"))});
    `);
    const run = await runWrapper(agent);
    const updates = run.lines.filter((line) => line.raw.includes("tool_call_update"));
    expect(updates).toHaveLength(2);
    // The merged snapshot arrived via the throttle timer, NOT with the late
    // chunk (which lands ~4 windows later) and not at process exit.
    const lateChunkAt = run.lines.find((line) => line.raw.includes("late"))!.atMs;
    expect(updates[1]!.atMs).toBeLessThan(lateChunkAt - THROTTLE_MS);
  });

  it("emits a leading edge again once a tool call has reached a terminal status", async () => {
    const run = await runWrapper(
      writeEmittingAgent([
        toolUpdate({ status: "in_progress", text: "first life" }),
        toolUpdate({ status: "completed" }),
        toolUpdate({ status: "in_progress", text: "second life" }),
      ]),
    );
    // The completed status evicted the throttle bookmark, so the reuse is a
    // fresh leading edge — visible because all three arrive despite being
    // emitted well inside one throttle window.
    const updates = toolUpdatesOf(parsed(run));
    expect(updates.map((u) => u.params.update.status)).toEqual([
      "in_progress",
      "completed",
      "in_progress",
    ]);
    expect(textOf(updates[2]!)).toBe("second life");
  });

  it("forwards every update when KIMI_COALESCE_MS is 0", async () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      toolUpdate({ status: "in_progress", text: `tick ${i + 1}` }),
    );
    const run = await runWrapper(writeEmittingAgent(lines), {
      env: { KIMI_COALESCE_MS: "0" },
    });
    expect(toolUpdatesOf(parsed(run))).toHaveLength(20);
  });
});

// --- thought-chunk coalescing ------------------------------------------------

describe("thought coalescing", () => {
  it("collapses a thought burst into leading + concatenated trailing, losslessly", async () => {
    // Multibyte and JSON-hostile characters ride along to catch escaping bugs.
    const parts = ["thinking", " → step 2", " héllo", ' "quoted" \\ path', " 終"];
    const agent = writeEmittingAgent([...parts.map((part) => thought(part)), chunk("done")]);
    const run = await runWrapper(agent);
    expect(run.code).toBe(0);

    const messages = parsed(run);
    const thoughts = thoughtChunksOf(messages);
    // Leading edge, then ONE merged trailing edge flushed by the message chunk.
    expect(thoughts).toHaveLength(2);
    expect(thoughtTextOf(thoughts[0]!)).toBe(parts[0]);
    expect(thoughtTextOf(thoughts[1]!)).toBe(parts.slice(1).join(""));
    // Lossless: the delivered text concatenates to exactly the sent text.
    expect(thoughts.map(thoughtTextOf).join("")).toBe(parts.join(""));

    // The message chunk flushed the held text before itself: order holds.
    const chunkIndex = messages.findIndex(
      (message) => message.params?.update?.sessionUpdate === "agent_message_chunk",
    );
    expect(chunkIndex).toBe(2);
    expect(messages).toHaveLength(3);
  });

  it("does not merge thought runs separated by other traffic", async () => {
    const run = await runWrapper(
      writeEmittingAgent([thought("before"), chunk("middle"), thought("after")]),
    );
    const messages = parsed(run);
    const thoughts = thoughtChunksOf(messages);
    // "before" is the leading edge; "after" arrives within the same window but
    // behind a message chunk, so it starts a new run rather than merging into
    // text that BB already closed.
    expect(thoughts).toHaveLength(2);
    expect(thoughtTextOf(thoughts[0]!)).toBe("before");
    expect(thoughtTextOf(thoughts[1]!)).toBe("after");
    expect(messages.map((m) => m.params?.update?.sessionUpdate)).toEqual([
      "agent_thought_chunk",
      "agent_message_chunk",
      "agent_thought_chunk",
    ]);
  });

  it("keeps thought streams independent per session", async () => {
    const run = await runWrapper(
      writeEmittingAgent([
        thought("s1 first", "s1"),
        thought("s2 first", "s2"),
        thought("s1 second", "s1"),
        thought("s2 second", "s2"),
      ]),
    );
    const thoughts = thoughtChunksOf(parsed(run));
    // Both sessions get a leading edge; their trailing edges merge per session.
    const bySession = (session: string) =>
      thoughts.filter((t) => t.params.sessionId === session).map(thoughtTextOf);
    expect(bySession("s1")).toEqual(["s1 first", "s1 second"]);
    expect(bySession("s2")).toEqual(["s2 first", "s2 second"]);
  });

  it("flushes held thought text on the trailing edge when the stream goes quiet", async () => {
    const agent = writeAgent(`
      emit(${JSON.stringify(thought("lead"))});
      for (let i = 1; i <= 5; i++) emit(${JSON.stringify(thought(" more"))});
      await sleep(${THROTTLE_MS * 4});
      emit(${JSON.stringify(chunk("late"))});
    `);
    const run = await runWrapper(agent);
    const thoughts = run.lines.filter((line) => line.raw.includes("agent_thought_chunk"));
    expect(thoughts).toHaveLength(2);
    expect(JSON.parse(thoughts[1]!.raw).params.update.content.text).toBe(" more".repeat(5));
    // The merged text arrived via the throttle timer, NOT with the late chunk.
    const lateChunkAt = run.lines.find((line) => line.raw.includes("late"))!.atMs;
    expect(thoughts[1]!.atMs).toBeLessThan(lateChunkAt - THROTTLE_MS);
  });

  it("passes a non-text thought chunk through untouched", async () => {
    const odd = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "resource" } },
      },
    });
    const run = await runWrapper(
      writeEmittingAgent([thought("lead"), thought("held"), odd, thought("tail")]),
    );
    const raw = run.lines.map((line) => line.raw);
    // The odd chunk lands verbatim, and the text held when it arrived ("held")
    // flushed before it — the odd chunk is a run boundary just like BB's.
    expect(raw).toContain(odd);
    const thoughts = thoughtChunksOf(parsed(run)).filter(
      (t) => t.params.update.content.type === "text",
    );
    expect(thoughts.map(thoughtTextOf)).toEqual(["lead", "held", "tail"]);
    expect(raw.indexOf(odd)).toBeGreaterThan(
      raw.findIndex((line) => line.includes('"held"')),
    );
  });

  it("forwards every thought chunk when KIMI_COALESCE_MS is 0", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => thought(`t${i + 1}`));
    const run = await runWrapper(writeEmittingAgent(lines), {
      env: { KIMI_COALESCE_MS: "0" },
    });
    expect(thoughtChunksOf(parsed(run))).toHaveLength(20);
  });
});

// --- ordering and passthrough ------------------------------------------------

describe("passthrough and ordering", () => {
  it("flushes held state before an id-bearing request, keeping permission prompts ordered", async () => {
    const run = await runWrapper(
      writeEmittingAgent([
        toolUpdate({ status: "in_progress", text: "lead" }),
        toolUpdate({ status: "in_progress", text: "held" }),
        PERMISSION_REQUEST,
      ]),
    );
    const raws = run.lines.map((line) => line.raw);
    const heldIndex = raws.findIndex((raw) => raw.includes("held"));
    const requestIndex = raws.findIndex((raw) => raw.includes("request_permission"));
    expect(heldIndex).toBeGreaterThan(-1);
    // BB must see the tool call's latest state before being asked about it.
    expect(heldIndex).toBeLessThan(requestIndex);
    expect(raws[requestIndex]).toBe(PERMISSION_REQUEST);
  });

  it("passes malformed JSON through verbatim after flushing held state", async () => {
    const run = await runWrapper(
      writeEmittingAgent([
        toolUpdate({ status: "in_progress", text: "lead" }),
        toolUpdate({ status: "in_progress", text: "held" }),
        "this is not json {",
      ]),
    );
    const raws = run.lines.map((line) => line.raw);
    expect(raws[raws.length - 1]).toBe("this is not json {");
    expect(raws.some((raw) => raw.includes("held"))).toBe(true);
  });

  it("does not coalesce shapes it does not fully recognize", async () => {
    const missingToolCallId = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "tool_call_update" } },
    });
    const idBearingUpdate = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "tool_call_update", toolCallId: "t1" },
      },
    });
    const run = await runWrapper(writeEmittingAgent([missingToolCallId, idBearingUpdate]));
    // Both are forwarded verbatim: byte-identical, uncounted, undelayed.
    expect(run.lines.map((line) => line.raw)).toEqual([missingToolCallId, idBearingUpdate]);
  });

  it("reassembles lines split across arbitrary write chunks", async () => {
    const line = toolUpdate({ status: "in_progress", text: "fragmented" });
    const pieces = [line.slice(0, 10), line.slice(10, 25), line.slice(25)];
    const agent = writeAgent(`
      for (const piece of ${JSON.stringify(pieces)}) {
        process.stdout.write(piece);
        await sleep(30);
      }
      process.stdout.write("\\n");
      emit(${JSON.stringify(chunk("after"))});
    `);
    const run = await runWrapper(agent);
    const messages = parsed(run);
    expect(textOf(messages[0]! as any)).toBe("fragmented");
    expect(messages).toHaveLength(2);
  });

  it("carries a multi-megabyte snapshot through intact", async () => {
    const bigText = "x".repeat(2 * 1024 * 1024);
    const run = await runWrapper(
      writeEmittingAgent([toolUpdate({ status: "in_progress", text: bigText })]),
    );
    const updates = toolUpdatesOf(parsed(run));
    expect(updates).toHaveLength(1);
    expect(textOf(updates[0]!)).toHaveLength(bigText.length);
  });

  it("pipes client stdin to the agent verbatim", async () => {
    // The echo agent proves the client→agent direction is a plain pipe.
    const agent = writeAgent(`
      process.stdin.setEncoding("utf8");
      let buffered = "";
      for await (const piece of process.stdin) {
        buffered += piece;
        let newline;
        while ((newline = buffered.indexOf("\\n")) !== -1) {
          emit("echo:" + buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
        }
      }
    `);
    const clientLines = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} }),
    ];
    const run = await runWrapper(agent, { stdinLines: clientLines });
    expect(run.lines.map((line) => line.raw)).toEqual(clientLines.map((l) => `echo:${l}`));
  });

  it("passes agent stderr through untouched", async () => {
    const agent = writeAgent(`
      process.stderr.write("first-run setup diagnostics\\n");
      emit(${JSON.stringify(chunk("ok"))});
    `);
    const run = await runWrapper(agent);
    expect(run.stderr).toContain("first-run setup diagnostics");
    expect(run.lines).toHaveLength(1);
  });
});

// --- process lifecycle -------------------------------------------------------

describe("process lifecycle", () => {
  it("propagates the agent's exit code", async () => {
    const agent = writeAgent(`
      emit(${JSON.stringify(chunk("about to fail"))});
      process.exitCode = 3;
    `);
    const run = await runWrapper(agent);
    expect(run.code).toBe(3);
    expect(run.lines).toHaveLength(1);
  });

  it("flushes held snapshots when the agent dies mid-burst", async () => {
    const run = await runWrapper(
      writeEmittingAgent([
        toolUpdate({ status: "in_progress", text: "lead" }),
        toolUpdate({ status: "in_progress", text: "final state" }),
      ]),
    );
    // No terminal status ever arrived, yet the last snapshot is not lost.
    const updates = toolUpdatesOf(parsed(run));
    expect(updates).toHaveLength(2);
    expect(textOf(updates[1]!)).toBe("final state");
  });

  it("exits with an error when the real CLI is missing", async () => {
    const run = await runWrapper(join(scratch, "no-such-binary"));
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("could not start");
  });

  it("forwards SIGTERM to the agent and dies with it", async () => {
    const agent = writeAgent(`
      emit(JSON.stringify({ jsonrpc: "2.0", method: "agent/pid", params: { pid: process.pid } }));
      await sleep(60_000);
    `);
    const run = await runWrapper(agent, {
      timeoutMs: 20_000,
      onLine: (raw, child) => {
        if (raw.includes("agent/pid")) child.kill("SIGTERM");
      },
    });
    expect(run.signal).toBe("SIGTERM");
    const agentPid = (JSON.parse(run.lines[0]!.raw) as any).params.pid as number;
    // The agent must be gone shortly after — no leaked kimi processes.
    await expect
      .poll(
        () => {
          try {
            process.kill(agentPid, 0);
            return "alive";
          } catch {
            return "gone";
          }
        },
        { timeout: 3000 },
      )
      .toBe("gone");
  });
});

// --- the launch snippet contract --------------------------------------------

describe("launch snippet", () => {
  it("names the materialized location and preserves the plain-CLI fallback", () => {
    expect(wrapper).toBe(join(scratch, WRAPPER_HOME_RELATIVE_PATH));
    expect(LAUNCH_SNIPPET).toContain(`$HOME/${WRAPPER_HOME_RELATIVE_PATH}`);
    expect(LAUNCH_SNIPPET).toContain('exec "${KIMI_ACP_REAL:-kimi}" "$@"');
  });
});
