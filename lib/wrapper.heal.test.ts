// Session-load healing, end to end against the materialized wrapper script.
//
// The scenario being defended: BB resumes a thread with `session/load`, Kimi
// rejects it because the session's ORIGINAL workspace root was destroyed
// (BB re-provisions worktree environments routinely), and — without the
// wrapper — BB's bridge silently swallows the error and continues in a fresh
// session, losing the agent's entire message history. The wrapper must
// recreate the directory, retry the load, and answer BB's original request id
// with the retry's result, so history restores instead of vanishing.
//
// Every test spawns the REAL wrapper file with a scripted fake agent, exactly
// as `wrapper.test.ts` does.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterAll, describe, expect, it } from "vitest";

import { materializeWrapper } from "./wrapper";

const scratch = mkdtempSync(join(tmpdir(), "kimi-heal-"));
const wrapper = materializeWrapper(scratch);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// The healed path must sit inside the wrapper's $HOME; tests point HOME at a
// per-run fake home directory so mkdir effects are observable and confined.
const fakeHome = mkdtempSync(join(tmpdir(), "kimi-heal-home-"));
afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

let agentCounter = 0;

/**
 * A fake agent that reads client lines and answers via a handler expression.
 * The body receives each parsed message as `message` and calls `emit(obj)`.
 */
function writeRespondingAgent(body: string): string {
  const path = join(scratch, `heal-agent-${agentCounter++}.mjs`);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
process.stdin.setEncoding("utf8");
let buffered = "";
process.stdin.on("data", (piece) => {
  buffered += piece;
  let newline;
  while ((newline = buffered.indexOf("\\n")) !== -1) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.length === 0) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    handle(message);
  }
});
function handle(message) {
${body}
}
`,
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

interface HealRun {
  code: number | null;
  lines: string[];
  stderr: string;
}

interface HealRunOptions {
  env?: Record<string, string>;
  stdinLines?: string[];
  /**
   * Raw stdin writes (strings or Buffers), sent sequentially with a small gap
   * — for exercising the client-side parser across chunk boundaries. The
   * caller controls newlines exactly.
   */
  stdinPieces?: (string | Buffer)[];
  /** Resolve once this many stdout lines have arrived (then the child is killed). */
  expectLines: number;
  /** Keep stdin open (so the wrapper stays alive) until expectLines arrive. */
  timeoutMs?: number;
}

function runHeal(agent: string, options: HealRunOptions): Promise<HealRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, "acp"], {
      env: {
        ...process.env,
        HOME: fakeHome,
        KIMI_ACP_REAL: agent,
        KIMI_COALESCE_MS: "50",
        ...options.env,
      },
    });
    const lines: string[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`expected ${options.expectLines} lines, saw:\n${lines.join("\n")}`));
    }, options.timeoutMs ?? 10_000);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, lines, stderr });
    };

    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString("utf8");
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
        const raw = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (raw.length > 0) lines.push(raw);
      }
      if (lines.length >= options.expectLines) {
        // Close stdin: the agent exits on stdin end, the wrapper follows.
        child.stdin.end();
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      setTimeout(() => finish(code), 50);
    });

    if (options.stdinPieces !== undefined) {
      void (async () => {
        for (const piece of options.stdinPieces!) {
          child.stdin.write(piece);
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      })();
    } else {
      for (const line of options.stdinLines ?? []) child.stdin.write(`${line}\n`);
    }
  });
}

function loadRequest(id: number | string, sessionId = "sess-1", cwd = "/tmp"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "session/load",
    params: { sessionId, cwd, mcpServers: [] },
  });
}

function workspaceError(id: number | string, path: string) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32603,
      message: "Internal error",
      data: { details: `workspace root ${path} does not exist` },
    },
  };
}

const LOAD_RESULT = { configOptions: [], models: { available: [] } };

describe("session/load healing", () => {
  it("recreates the missing workspace root and answers BB's original id with success", async () => {
    const missing = join(fakeHome, "workspaces", "env_gone");
    expect(existsSync(missing)).toBe(false);
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      import("node:fs").then(({ existsSync }) => {
        if (existsSync(${JSON.stringify(missing)})) {
          emit({ jsonrpc: "2.0", id: message.id, result: ${JSON.stringify(LOAD_RESULT)} });
        } else {
          emit(${JSON.stringify(workspaceError("__ID__", missing)).replace('"__ID__"', "message.id")});
        }
      });
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest(42)],
      expectLines: 1,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe(42);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(LOAD_RESULT);
    // Exactly one response reached BB, and the directory really exists now.
    expect(run.lines).toHaveLength(1);
    expect(existsSync(missing)).toBe(true);
    expect(run.stderr).toContain("recreated missing workspace root");
  });

  it("preserves a string request id through the heal", async () => {
    const missing = join(fakeHome, "workspaces", "env_string_id");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      import("node:fs").then(({ existsSync }) => {
        if (existsSync(${JSON.stringify(missing)})) {
          emit({ jsonrpc: "2.0", id: message.id, result: ${JSON.stringify(LOAD_RESULT)} });
        } else {
          emit(${JSON.stringify(workspaceError("__ID__", missing)).replace('"__ID__"', "message.id")});
        }
      });
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest("req-abc")],
      expectLines: 1,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe("req-abc");
    expect(response.result).toEqual(LOAD_RESULT);
  });

  it("forwards the retry's error under the original id when the retry also fails", async () => {
    const missing = join(fakeHome, "workspaces", "env_retry_fails");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      // Fails BOTH times, with the workspace error first and an auth error on
      // the wrapper's retry id.
      if (String(message.id).startsWith("__kimi_coalesce_retry__")) {
        emit({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required" } });
      } else {
        emit(${JSON.stringify(workspaceError("__ID__", missing)).replace('"__ID__"', "message.id")});
      }
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest(7)],
      expectLines: 1,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe(7);
    expect(response.error.message).toBe("Authentication required");
    expect(run.lines).toHaveLength(1);
  });

  it("passes a non-workspace load error through untouched", async () => {
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      emit({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required" } });
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest(3)],
      expectLines: 1,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe(3);
    expect(response.error.message).toBe("Authentication required");
    expect(run.stderr).not.toContain("recreated");
  });

  it("refuses to heal a path outside $HOME and forwards the original error", async () => {
    const outside = join(tmpdir(), "kimi-heal-escape", "evil");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      emit(${JSON.stringify(workspaceError("__ID__", outside)).replace('"__ID__"', "message.id")});
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest(4)],
      expectLines: 1,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe(4);
    expect(response.error.data.details).toContain("does not exist");
    expect(existsSync(outside)).toBe(false);
  });

  it("refuses traversal segments even when the path starts inside $HOME", async () => {
    const traversal = `${fakeHome}/ok/../../../etc/kimi-evil`;
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      emit(${JSON.stringify(workspaceError("__ID__", traversal)).replace('"__ID__"', "message.id")});
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest(5)],
      expectLines: 1,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe(5);
    expect(response.error).toBeDefined();
    expect(existsSync("/etc/kimi-evil")).toBe(false);
  });

  it("does nothing when healing is disabled via KIMI_SESSION_LOAD_HEAL=0", async () => {
    const missing = join(fakeHome, "workspaces", "env_disabled");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      emit(${JSON.stringify(workspaceError("__ID__", missing)).replace('"__ID__"', "message.id")});
    `);
    const run = await runHeal(agent, {
      env: { KIMI_SESSION_LOAD_HEAL: "0" },
      stdinLines: [loadRequest(6)],
      expectLines: 1,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe(6);
    expect(response.error).toBeDefined();
    expect(existsSync(missing)).toBe(false);
  });

  it("releases the held original error if the agent dies before answering the retry", async () => {
    const missing = join(fakeHome, "workspaces", "env_agent_dies");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      if (String(message.id).startsWith("__kimi_coalesce_retry__")) {
        // Die without answering the retry.
        process.exit(1);
      }
      emit(${JSON.stringify(workspaceError("__ID__", missing)).replace('"__ID__"', "message.id")});
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest(8)],
      expectLines: 1,
      timeoutMs: 10_000,
    });
    const response = JSON.parse(run.lines[0]!);
    // BB's request settles with the ORIGINAL error rather than hanging forever.
    expect(response.id).toBe(8);
    expect(response.error.data.details).toContain("does not exist");
  });

  it("lets replayed notifications through while a load is in flight", async () => {
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "replayed" } } } });
      emit({ jsonrpc: "2.0", id: message.id, result: ${JSON.stringify(LOAD_RESULT)} });
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest(9)],
      expectLines: 2,
    });
    expect(run.lines[0]).toContain("replayed");
    expect(JSON.parse(run.lines[1]!).id).toBe(9);
  });

  it("still coalesces tool progress while remembering load requests", async () => {
    // Healing must not regress the wrapper's original job: a burst of
    // tool_call_update ticks still collapses.
    const tick = (n: number) =>
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            status: "in_progress",
            content: [{ type: "content", content: { type: "text", text: `tick ${n}` } }],
          },
        },
      });
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      ${Array.from({ length: 30 }, (_, i) => `emit(${tick(i + 1)});`).join("\n      ")}
      emit({ jsonrpc: "2.0", id: message.id, result: ${JSON.stringify(LOAD_RESULT)} });
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest(10)],
      expectLines: 3,
    });
    const updates = run.lines.filter((line) => line.includes("tool_call_update"));
    // Leading edge + merged flush (forced by the id-bearing response line).
    expect(updates.length).toBeLessThan(30);
    expect(updates[0]).toContain("tick 1");
    const last = JSON.parse(run.lines[run.lines.length - 1]!);
    expect(last.id).toBe(10);
  });

  it("tracks a session/load request split across arbitrary stdin chunks", async () => {
    const missing = join(fakeHome, "workspaces", "env_chunked");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      import("node:fs").then(({ existsSync }) => {
        if (existsSync(${JSON.stringify(missing)})) {
          emit({ jsonrpc: "2.0", id: message.id, result: ${JSON.stringify(LOAD_RESULT)} });
        } else {
          emit(${JSON.stringify(workspaceError("__ID__", missing)).replace('"__ID__"', "message.id")});
        }
      });
    `);
    const line = loadRequest(20);
    const run = await runHeal(agent, {
      stdinPieces: [line.slice(0, 15), line.slice(15, 40), `${line.slice(40)}\n`],
      expectLines: 1,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe(20);
    expect(response.result).toEqual(LOAD_RESULT);
    expect(existsSync(missing)).toBe(true);
  });

  it("survives multi-byte UTF-8 split across stdin chunk boundaries", async () => {
    // The cwd carries a 4-byte emoji; the split lands mid-character. The
    // parser must still recognize the request (and the forwarded bytes must
    // reach the agent uncorrupted, proven by the echoed cwd in its error).
    const missing = join(fakeHome, "workspaces", "env_🦊_utf8");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      import("node:fs").then(({ existsSync }) => {
        if (existsSync(${JSON.stringify(missing)})) {
          emit({ jsonrpc: "2.0", id: message.id, result: { echoedCwd: message.params.cwd } });
        } else {
          emit(${JSON.stringify(workspaceError("__ID__", missing)).replace('"__ID__"', "message.id")});
        }
      });
    `);
    const line = Buffer.from(`${loadRequest(21, "sess-utf8", missing)}\n`, "utf8");
    const emojiByteIndex = line.indexOf(Buffer.from("🦊", "utf8")) + 2; // mid-emoji
    const run = await runHeal(agent, {
      stdinPieces: [line.subarray(0, emojiByteIndex), line.subarray(emojiByteIndex)],
      expectLines: 1,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe(21);
    expect(response.result.echoedCwd).toBe(missing);
    expect(existsSync(missing)).toBe(true);
  });

  it("does not confuse a string id with the same numeric id", async () => {
    // BB sent id 30 (number); a response bearing id "30" (string) is NOT the
    // answer to that request and must pass through untouched, unhealed.
    const missing = join(fakeHome, "workspaces", "env_id_type");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      emit(${JSON.stringify(workspaceError("30", missing))});
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest(30)],
      expectLines: 1,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe("30");
    expect(response.error).toBeDefined();
    expect(existsSync(missing)).toBe(false);
    expect(run.stderr).not.toContain("recreated");
  });

  it("heals from the error.message variant when error.data is absent", async () => {
    const missing = join(fakeHome, "workspaces", "env_message_variant");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      import("node:fs").then(({ existsSync }) => {
        if (existsSync(${JSON.stringify(missing)})) {
          emit({ jsonrpc: "2.0", id: message.id, result: ${JSON.stringify(LOAD_RESULT)} });
        } else {
          emit({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "workspace root ${missing} does not exist" } });
        }
      });
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest(31)],
      expectLines: 1,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe(31);
    expect(response.result).toEqual(LOAD_RESULT);
    expect(existsSync(missing)).toBe(true);
  });

  it("heals a path containing spaces and non-ASCII characters", async () => {
    const missing = join(fakeHome, "work spaces", "envürö dir");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      import("node:fs").then(({ existsSync }) => {
        if (existsSync(${JSON.stringify(missing)})) {
          emit({ jsonrpc: "2.0", id: message.id, result: ${JSON.stringify(LOAD_RESULT)} });
        } else {
          emit(${JSON.stringify(workspaceError("__ID__", missing)).replace('"__ID__"', "message.id")});
        }
      });
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest(32)],
      expectLines: 1,
    });
    expect(JSON.parse(run.lines[0]!).result).toEqual(LOAD_RESULT);
    expect(existsSync(missing)).toBe(true);
  });

  it("refuses to heal $HOME itself", async () => {
    // The confinement requires a path STRICTLY inside home — "home/" prefix —
    // so the home directory itself is never a mkdir target.
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      emit(${JSON.stringify(workspaceError("__ID__", "__HOME__")).replace('"__ID__"', "message.id").replace("__HOME__", fakeHome)});
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest(33)],
      expectLines: 1,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe(33);
    expect(response.error).toBeDefined();
    expect(run.stderr).not.toContain("recreated");
  });

  it("forwards the original error when a file blocks the mkdir", async () => {
    // A FILE at the exact path mkdir would create makes the heal impossible.
    const blocked = join(fakeHome, "workspaces", "env_blocked_by_file");
    mkdirSync(join(fakeHome, "workspaces"), { recursive: true });
    writeFileSync(blocked, "i am a file");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      emit(${JSON.stringify(workspaceError("__ID__", blocked)).replace('"__ID__"', "message.id")});
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest(34)],
      expectLines: 1,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe(34);
    expect(response.error.data.details).toContain("does not exist");
  });

  it("heals two concurrent loads independently, answering each original id", async () => {
    const missingA = join(fakeHome, "workspaces", "env_conc_a");
    const missingB = join(fakeHome, "workspaces", "env_conc_b");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      const target = message.params.sessionId === "sess-a"
        ? ${JSON.stringify(missingA)}
        : ${JSON.stringify(missingB)};
      import("node:fs").then(({ existsSync }) => {
        if (existsSync(target)) {
          emit({ jsonrpc: "2.0", id: message.id, result: { loaded: message.params.sessionId } });
        } else {
          emit({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error", data: { details: \`workspace root \${target} does not exist\` } } });
        }
      });
    `);
    const run = await runHeal(agent, {
      stdinLines: [loadRequest(41, "sess-a"), loadRequest(42, "sess-b")],
      expectLines: 2,
    });
    const responses = run.lines.map((line) => JSON.parse(line));
    const byId = new Map(responses.map((response) => [response.id, response]));
    expect(byId.get(41)?.result).toEqual({ loaded: "sess-a" });
    expect(byId.get(42)?.result).toEqual({ loaded: "sess-b" });
    expect(existsSync(missingA)).toBe(true);
    expect(existsSync(missingB)).toBe(true);
  });

  it("evicts the oldest pending load beyond the cap, keeping recent ones healable", async () => {
    const missing = join(fakeHome, "workspaces", "env_cap_recent");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      // Only ever answer the LAST request (id 139); everything else hangs.
      if (message.id !== 139 && !String(message.id).startsWith("__kimi_coalesce_retry__")) return;
      import("node:fs").then(({ existsSync }) => {
        if (existsSync(${JSON.stringify(missing)})) {
          emit({ jsonrpc: "2.0", id: message.id, result: ${JSON.stringify(LOAD_RESULT)} });
        } else {
          emit(${JSON.stringify(workspaceError("__ID__", missing)).replace('"__ID__"', "message.id")});
        }
      });
    `);
    // 40 pending loads (cap is 32): the earliest are evicted, the newest must
    // still heal.
    const run = await runHeal(agent, {
      stdinLines: Array.from({ length: 40 }, (_, i) => loadRequest(100 + i)),
      expectLines: 1,
      timeoutMs: 15_000,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe(139);
    expect(response.result).toEqual(LOAD_RESULT);
  });

  it("forwards an evicted load's workspace error unhealed", async () => {
    const missing = join(fakeHome, "workspaces", "env_cap_evicted");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      // Answer the FIRST request (id 200) only after ALL 40 have arrived, so
      // the wrapper has provably evicted it before the error lands.
      globalThis.loadCount = (globalThis.loadCount ?? 0) + 1;
      if (globalThis.loadCount !== 40) return;
      emit(${JSON.stringify(workspaceError(200, missing))});
    `);
    const run = await runHeal(agent, {
      stdinLines: Array.from({ length: 40 }, (_, i) => loadRequest(200 + i)),
      expectLines: 1,
      timeoutMs: 15_000,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe(200);
    expect(response.error).toBeDefined();
    expect(existsSync(missing)).toBe(false);
  });

  it("ignores oversized client lines without breaking later heals", async () => {
    const missing = join(fakeHome, "workspaces", "env_after_big_line");
    const agent = writeRespondingAgent(`
      if (message.method !== "session/load") return;
      import("node:fs").then(({ existsSync }) => {
        if (existsSync(${JSON.stringify(missing)})) {
          emit({ jsonrpc: "2.0", id: message.id, result: ${JSON.stringify(LOAD_RESULT)} });
        } else {
          emit(${JSON.stringify(workspaceError("__ID__", missing)).replace('"__ID__"', "message.id")});
        }
      });
    `);
    // A >1MB prompt-like line precedes the load; the parser must skip it and
    // still track the session/load that follows.
    const bigLine = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { big: "x".repeat(1_200_000) },
    });
    const run = await runHeal(agent, {
      stdinLines: [bigLine, loadRequest(11)],
      expectLines: 1,
      timeoutMs: 15_000,
    });
    const response = JSON.parse(run.lines[0]!);
    expect(response.id).toBe(11);
    expect(response.result).toEqual(LOAD_RESULT);
    expect(existsSync(missing)).toBe(true);
  });
});
