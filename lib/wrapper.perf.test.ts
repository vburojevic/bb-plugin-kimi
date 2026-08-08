// Performance characteristics of the coalescer under flood load.
//
// These are guardrail tests, not benchmarks: bounds are set several times
// wider than observed so they catch an accidental O(n²) or a broken throttle,
// never a slow CI box. Observed on an M-series laptop: the 20k-update flood
// completes in well under 2s with single-digit emissions per tool call.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

import { afterAll, describe, expect, it } from "vitest";

import { materializeWrapper } from "./wrapper";

const scratch = mkdtempSync(join(tmpdir(), "kimi-coalesce-perf-"));
const wrapper = materializeWrapper(scratch);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * A generator agent: writes its flood programmatically so the fixture file
 * stays small, and reports its own line count as the last message.
 */
function writeFloodAgent(name: string, body: string): string {
  const path = join(scratch, `${name}.mjs`);
  writeFileSync(
    path,
    `#!/usr/bin/env node
let emitted = 0;
const emit = (value) => {
  process.stdout.write(JSON.stringify(value) + "\\n");
  emitted++;
};
${body}
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "flood/done", params: { emitted } }) + "\\n");
`,
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

function update(tool: string, i: number, status = "in_progress") {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: tool,
        status,
        content: [
          {
            type: "content",
            content: { type: "text", text: `output snapshot ${i} for ${tool} `.repeat(8) },
          },
        ],
      },
    },
  };
}

function runWrapper(
  agent: string,
): Promise<{ code: number; lines: string[]; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = execFile(
      process.execPath,
      [wrapper, "acp"],
      {
        env: { ...process.env, KIMI_ACP_REAL: agent, KIMI_COALESCE_MS: "200" },
        timeout: 30_000,
        maxBuffer: 256 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({
          code: 0,
          lines: stdout.split("\n").filter((line) => line.length > 0),
          elapsedMs: Date.now() - startedAt,
        });
      },
    );
    child.stdin?.end();
  });
}

function toolUpdateCount(lines: string[]): number {
  return lines.filter((line) => line.includes('"tool_call_update"')).length;
}

describe("coalescer under flood", () => {
  it("reduces a 20k-update flood by ≥99% without losing terminal states", async () => {
    const agent = writeFloodAgent(
      "flood-interleaved",
      `
const tools = ["t1", "t2", "t3", "t4"];
for (let i = 1; i <= 5000; i++) {
  for (const tool of tools) emit(${update.toString()}(tool, i));
}
for (const tool of tools) emit(${update.toString()}(tool, 5001, "completed"));
`,
    );
    const { lines, elapsedMs } = await runWrapper(agent);

    const emitted = toolUpdateCount(lines);
    // 20,004 in. Expect leading edges + a few timer flushes + terminals.
    expect(emitted).toBeLessThanOrEqual(60);
    expect(emitted).toBeGreaterThanOrEqual(8); // 4 leads + 4 terminals at minimum
    // Every tool call's terminal state survived, carrying the final snapshot.
    for (const tool of ["t1", "t2", "t3", "t4"]) {
      const terminal = lines
        .filter((line) => line.includes(`"${tool}"`) && line.includes('"completed"'))
        .at(-1);
      expect(terminal, `terminal state for ${tool}`).toBeDefined();
      expect(terminal).toContain(`snapshot 5001 for ${tool}`);
    }
    // Not a benchmark — this catches quadratic blowups, nothing subtler.
    expect(elapsedMs).toBeLessThan(15_000);
  }, 40_000);

  it("forwards 20k non-coalescable messages without loss or reordering", async () => {
    const agent = writeFloodAgent(
      "flood-passthrough",
      `
for (let i = 1; i <= 20000; i++) {
  emit({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "chunk " + i } },
    },
  });
}
`,
    );
    const { lines, elapsedMs } = await runWrapper(agent);

    // 20k chunks + the flood/done trailer, all intact and in order.
    expect(lines).toHaveLength(20_001);
    expect(lines[0]).toContain('"chunk 1"');
    expect(lines[19_999]).toContain('"chunk 20000"');
    expect(lines[20_000]).toContain('"flood/done"');
    expect(elapsedMs).toBeLessThan(15_000);
  }, 40_000);

  it("stays correct across thousands of short-lived tool calls", async () => {
    // The long-session shape: many tool calls, each a lead + a terminal.
    // Exercises the throttle-bookmark eviction path at scale — nothing may be
    // dropped, merged across keys, or delayed behind a stale bookmark.
    const agent = writeFloodAgent(
      "flood-many-tools",
      `
for (let i = 1; i <= 3000; i++) {
  emit(${update.toString()}("tool-" + i, 1));
  emit(${update.toString()}("tool-" + i, 2, "completed"));
}
`,
    );
    const { lines, elapsedMs } = await runWrapper(agent);
    expect(toolUpdateCount(lines)).toBe(6000);
    expect(elapsedMs).toBeLessThan(15_000);
  }, 40_000);
});
