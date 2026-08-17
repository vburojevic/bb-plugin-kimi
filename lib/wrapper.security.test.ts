// Adversarial input for the coalescer: the agent side of the pipe is
// untrusted, and these tests feed it what a hostile or broken CLI could —
// multi-byte characters split across pipe chunks, lines too large to buffer,
// prototype-pollution payloads, and floods against a stalled reader.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";

import { afterAll, describe, expect, it } from "vitest";

import { materializeWrapper } from "./wrapper";

const scratch = mkdtempSync(join(tmpdir(), "kimi-coalesce-sec-"));
const wrapper = materializeWrapper(scratch);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let agentCounter = 0;

function writeAgent(body: string): string {
  const path = join(scratch, `sec-agent-${agentCounter++}.mjs`);
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { once } from "node:events";
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

function runWrapper(
  agent: string,
  env: Record<string, string> = {},
): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [wrapper, "acp"],
      {
        env: { ...process.env, KIMI_ACP_REAL: agent, KIMI_COALESCE_MS: "200", ...env },
        timeout: 20_000,
        maxBuffer: 512 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          code: error === null ? 0 : (error.code as number),
          lines: stdout.split("\n").filter((line) => line.length > 0),
        });
      },
    );
    child.stdin?.end();
  });
}

describe("UTF-8 integrity across chunk boundaries", () => {
  it("never mangles multi-byte characters split by the pipe", async () => {
    // A snapshot whose text is entirely multi-byte, written byte-by-byte in
    // slices deliberately cut inside characters — the worst case a 64KB pipe
    // boundary can produce.
    const text = "日本語のテスト出力🚀複数バイト文字".repeat(40);
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text } }],
        },
      },
    });
    const agent = writeAgent(`
      const bytes = Buffer.from(${JSON.stringify(line)} + "\\n", "utf8");
      // Slices of 7 bytes: guaranteed to split 3-byte CJK and 4-byte emoji.
      for (let offset = 0; offset < bytes.length; offset += 7) {
        process.stdout.write(bytes.subarray(offset, offset + 7));
        if (offset % 700 === 0) await sleep(1);
      }
    `);
    const { code, lines } = await runWrapper(agent);
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    const roundTripped = JSON.parse(lines[0]!) as any;
    const received = roundTripped.params.update.content[0].content.text as string;
    expect(received).not.toContain("�");
    expect(received).toBe(text);
  });
});

describe("oversized lines", () => {
  // The cap's OBSERVABLE effect is that an oversized line stops being
  // coalescable: it is too large to hold, so it streams straight through
  // instead of being merged into the pending snapshot. Asserting that a
  // would-be-coalesced update appears VERBATIM is what makes this test fail
  // if the cap is removed — asserting only that "nothing was lost" does not,
  // because a working coalescer also loses nothing.
  const capBytes = 64 * 1024;
  const oversizedUpdate = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "y".repeat(capBytes * 4) } }],
      },
    },
  });
  const lead = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" },
    },
  });
  const terminal = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
    },
  });

  it("streams a line above the buffer cap through verbatim, bypassing coalescing", async () => {
    const agent = writeAgent(`
      emit(${JSON.stringify(lead)});
      emit(${JSON.stringify(oversizedUpdate)});
      emit(${JSON.stringify(terminal)});
    `);
    const { code, lines } = await runWrapper(agent, {
      KIMI_MAX_LINE_BYTES: String(capBytes),
    });
    expect(code).toBe(0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(lead);
    // Byte-identical and UNMERGED — only the cap can produce this.
    expect(lines[1]).toBe(oversizedUpdate);
    expect(lines[2]).toContain('"completed"');
  });

  it("coalesces that same update when it fits under the cap (the cap is load-bearing)", async () => {
    // Identical input, cap raised above the payload: now the oversized update
    // IS held and merged, so it must NOT appear verbatim. This is the control
    // that proves the assertion above is detecting the cap and not something
    // incidental about large lines.
    const agent = writeAgent(`
      emit(${JSON.stringify(lead)});
      emit(${JSON.stringify(oversizedUpdate)});
      emit(${JSON.stringify(terminal)});
    `);
    const { code, lines } = await runWrapper(agent, {
      KIMI_MAX_LINE_BYTES: String(capBytes * 100),
    });
    expect(code).toBe(0);
    expect(lines).not.toContain(oversizedUpdate);
    // Merged into the terminal snapshot instead, carrying the payload forward.
    expect(lines.at(-1)).toContain('"completed"');
    expect(lines.at(-1)!.length).toBeGreaterThan(capBytes * 4);
  });
});

describe("wrapper source hygiene", () => {
  it("materializes without raw control characters", () => {
    // WRAPPER_SOURCE is a template literal: an innocent-looking `\0` (or any
    // raw escape) in a comment becomes a literal control byte in the file
    // every host downloads — grep then calls it binary and some tooling
    // chokes. Everything past tab/CR/LF must be printable.
    const content = readFileSync(wrapper, "utf8");
    // eslint-disable-next-line no-control-regex
    const offenders = content.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g);
    expect(offenders).toBeNull();
  });
});

describe("prototype pollution", () => {
  it("keeps a hostile __proto__ key as inert merged data", async () => {
    // Raw JSON on purpose: in a JS object literal `__proto__:` is prototype-
    // setter syntax and the key would never reach the wire. JSON.parse, by
    // contrast, creates it as an ordinary own property — which is exactly
    // what a hostile agent can send.
    const lead = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" },
      },
    });
    const hostileHeld =
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1",' +
      '"update":{"sessionUpdate":"tool_call_update","toolCallId":"t1",' +
      '"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}}';
    const terminal = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
      },
    });
    // lead emits; hostileHeld is held; terminal merges INTO the hostile
    // object and emits — the exact code path a pollution payload targets.
    const agent = writeAgent(
      `emit(${JSON.stringify(lead)}); emit(${JSON.stringify(hostileHeld)}); emit(${JSON.stringify(terminal)});`,
    );
    const { code, lines } = await runWrapper(agent);
    expect(code).toBe(0);
    expect(lines).toHaveLength(2);
    // The merge must carry "__proto__" forward as an OWN data key. If spread
    // ever regressed to setter semantics, the key would vanish from the JSON
    // (having become the merged object's prototype instead — real pollution).
    const merged = lines[1]!;
    expect(merged).toContain('"__proto__":{"polluted":true}');
    expect(merged).toContain('"status":"completed"');
    const parsed = JSON.parse(merged) as any;
    expect(parsed.polluted).toBeUndefined();
    expect(parsed.params.update.polluted).toBeUndefined();
  });
});

describe("abnormal termination", () => {
  it("delivers everything the agent flushed even when the agent is killed by a signal", async () => {
    // HONEST SCOPE NOTE: this is a delivery-completeness guard, not a
    // discriminator for the 'exit' -> 'close' teardown fix. An audit reported
    // that the old synchronous re-raise dropped queued output; I could not
    // reproduce that, and this test passes against the old teardown too —
    // because the backpressure logic keeps the proxy from accumulating a
    // stdout backlog in the first place (it pauses the agent instead). The
    // teardown fix is retained as strictly-safer ordering, and this test
    // stands as the regression guard for the property that actually matters:
    // a signal-killed agent must not cost BB any bytes the agent had written.
    //
    // The reader stays paused across the kill so any queued state is exercised.
    // The agent reports (on stderr) how many bytes it saw flushed into the
    // pipe; the proxy passes these lines through verbatim, so anything less
    // than that number arriving is data the proxy dropped.
    const agent = writeAgent(`
      const line = JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "w".repeat(2048) } } },
      }) + "\\n";
      let flushed = 0;
      process.on("SIGTERM", () => {
        process.stderr.write("FLUSHED:" + flushed + "\\n");
        process.exit(0);
      });
      process.stderr.write("PID:" + process.pid + "\\n");
      for (let i = 0; i < 400; i++) {
        const room = process.stdout.write(line, () => { flushed += Buffer.byteLength(line); });
        if (!room) await once(process.stdout, "drain");
      }
      process.stderr.write("WROTE_ALL\\n");
      await sleep(60_000);
    `);

    const child = spawn(process.execPath, [wrapper, "acp"], {
      env: { ...process.env, KIMI_ACP_REAL: agent, KIMI_COALESCE_MS: "200" },
    });
    child.stdin.end();
    child.stdout.pause(); // reader stalls; a backlog builds inside the proxy

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (piece: string) => {
      stderr += piece;
    });

    // Wait for the agent to announce itself, so the kill can never race its
    // startup (which made this flaky under full-suite load), then let a
    // backlog build before killing it by pid.
    await expect.poll(() => /PID:(\d+)/u.test(stderr), { timeout: 15_000 }).toBe(true);
    const agentPid = Number(/PID:(\d+)/u.exec(stderr)![1]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.kill(agentPid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Now drain, well inside the proxy's flush guard.
    let received = 0;
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (piece: string) => {
      received += Buffer.byteLength(piece);
      out += piece;
    });
    child.stdout.resume();

    await new Promise<void>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("wrapper never exited")), 20_000);
      child.on("close", () => {
        clearTimeout(guard);
        resolve();
      });
    });

    const flushed = Number(/FLUSHED:(\d+)/u.exec(stderr)?.[1] ?? "-1");
    expect(flushed).toBeGreaterThan(64 * 1024); // a real backlog existed
    // Not one byte the agent successfully wrote may be dropped.
    expect(received).toBeGreaterThanOrEqual(flushed);
    for (const line of out.split("\n").filter((line) => line.length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 40_000);

  it("does not orphan the agent when the proxy is SIGKILLed", async () => {
    // SIGKILL cannot be caught, so the proxy cannot forward it. The agent
    // must still die: killing the proxy closes the stdin pipe it holds, and
    // an ACP agent that sees EOF on stdin exits. This is the property that
    // keeps a killed thread from leaving `kimi acp` running on the machine.
    const agent = writeAgent(`
      emit(JSON.stringify({ jsonrpc: "2.0", method: "agent/ready", params: { pid: process.pid } }));
      process.stdin.resume();
      process.stdin.on("end", () => process.exit(0));
      process.stdin.on("close", () => process.exit(0));
      await sleep(60_000);
    `);

    const child = spawn(process.execPath, [wrapper, "acp"], {
      env: { ...process.env, KIMI_ACP_REAL: agent, KIMI_COALESCE_MS: "200" },
    });
    const agentPid = await new Promise<number>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("agent never announced")), 15_000);
      child.stdout.on("data", (data: Buffer) => {
        const match = /"pid":(\d+)/u.exec(data.toString("utf8"));
        if (match !== null) {
          clearTimeout(guard);
          resolve(Number(match[1]));
        }
      });
    });

    child.kill("SIGKILL");
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
        { timeout: 10_000, interval: 200 },
      )
      .toBe("gone");
  }, 30_000);
});

describe("backpressure", () => {
  it("pauses the agent instead of buffering without bound when the reader stalls", async () => {
    // ~96MB of passthrough traffic against a reader that refuses to consume
    // for a while. With backpressure the wrapper's own memory stays near
    // baseline — the flood waits in the agent, not in the proxy.
    const agent = writeAgent(`
      const line = JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "z".repeat(8192) } } },
      });
      for (let i = 0; i < 12000; i++) {
        if (!process.stdout.write(line + "\\n")) await once(process.stdout, "drain");
      }
    `);

    const child = spawn(process.execPath, [wrapper, "acp"], {
      env: { ...process.env, KIMI_ACP_REAL: agent, KIMI_COALESCE_MS: "200" },
    });
    child.stdin.end();
    child.stdout.pause(); // the stalled reader

    // Let the flood slam into the stall, sampling the proxy's memory.
    let peakRssKb = 0;
    for (let sample = 0; sample < 6; sample++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const rss = Number(execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8" }).trim());
        if (Number.isFinite(rss)) peakRssKb = Math.max(peakRssKb, rss);
      } catch {
        break; // already exited — nothing more to sample
      }
    }
    // Well under the ~96MB payload: the flood is NOT sitting in the wrapper.
    expect(peakRssKb).toBeGreaterThan(0);
    expect(peakRssKb).toBeLessThan(80 * 1024);

    // Release the stall: every byte still arrives.
    let received = 0;
    child.stdout.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      received += chunk.length;
    });
    await new Promise<void>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("flood never completed")), 30_000);
      child.on("exit", () => {
        // Drain callbacks queued behind exit before counting.
        setTimeout(() => {
          clearTimeout(guard);
          resolve();
        }, 200);
      });
    });
    expect(received).toBeGreaterThan(12000 * 8192);
  }, 45_000);
});
