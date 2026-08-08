// probeAcpAgent against real spawned processes: a scripted ACP agent for the
// happy path and its documented failure modes for the rest. The probe is the
// diagnostic BB users reach for first (`bb kimi doctor`), so its verdicts —
// especially the difference between missing_executable, timeout, and
// handshake_failed — must stay truthful.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { findModelOption, findThinkingOption, probeAcpAgent } from "./acp-probe";

const scratch = mkdtempSync(join(tmpdir(), "kimi-probe-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let agentCounter = 0;

/**
 * A minimal ACP agent: answers `initialize` and `session/new` from a response
 * table, with hooks for banners, errors, and silence.
 */
function writeAcpAgent(options: {
  banner?: string;
  initializeResult?: unknown;
  sessionResult?: unknown;
  sessionError?: { message: string };
  silent?: boolean;
  exitImmediately?: { code: number; stderr: string };
}): string {
  const path = join(scratch, `acp-agent-${agentCounter++}.mjs`);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const options = ${JSON.stringify(options)};
if (options.exitImmediately) {
  process.stderr.write(options.exitImmediately.stderr);
  process.exit(options.exitImmediately.code);
}
if (options.banner) process.stdout.write(options.banner + "\\n");
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.setEncoding("utf8");
let buffered = "";
process.stdin.on("data", (piece) => {
  buffered += piece;
  let newline;
  while ((newline = buffered.indexOf("\\n")) !== -1) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (options.silent) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      const base = options.initializeResult ?? {
        protocolVersion: 1,
        authMethods: [{ id: "login", name: "Device login" }],
        agentInfo: { name: process.env.PROBE_AGENT_NAME ?? "Fake Kimi", version: "9.9.9" },
      };
      reply({ jsonrpc: "2.0", id: message.id, result: base });
    } else if (message.method === "session/new") {
      if (options.sessionError) {
        reply({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: options.sessionError.message } });
      } else {
        reply({
          jsonrpc: "2.0",
          id: message.id,
          result: options.sessionResult ?? {
            sessionId: "sess_1",
            configOptions: [
              {
                id: "model",
                category: "model",
                currentValue: "kimi-code/kimi-for-coding",
                options: [{ value: "kimi-code/kimi-for-coding" }, { value: "kimi-code/k3" }],
              },
              {
                id: "thinking",
                category: "thought_level",
                options: [{ value: "low" }, { value: "high" }, { value: "max" }],
              },
            ],
          },
        });
      }
    }
  }
});
// Exit when the client closes stdin, like a real CLI.
process.stdin.on("end", () => process.exit(0));
`,
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

describe("probeAcpAgent", () => {
  it("completes the two-step handshake and reports what the agent advertises", async () => {
    const agent = writeAcpAgent({});
    const probe = await probeAcpAgent({ command: agent, args: ["acp"], cwd: scratch });
    expect(probe.ok).toBe(true);
    expect(probe.error).toBeNull();
    expect(probe.agentName).toBe("Fake Kimi");
    expect(probe.agentVersion).toBe("9.9.9");
    expect(probe.protocolVersion).toBe(1);
    expect(probe.authMethods.map((method) => method.id)).toEqual(["login"]);

    const model = findModelOption(probe.configOptions);
    expect(model?.options?.map((option) => option.value)).toEqual([
      "kimi-code/kimi-for-coding",
      "kimi-code/k3",
    ]);
    const thinking = findThinkingOption(probe.configOptions);
    expect(thinking?.options?.map((option) => option.value)).toEqual(["low", "high", "max"]);
  });

  it("layers caller env over the process env — the wrapped-entry contract", async () => {
    const agent = writeAcpAgent({});
    const probe = await probeAcpAgent({
      command: agent,
      args: ["acp"],
      cwd: scratch,
      env: { PROBE_AGENT_NAME: "Env Layered Agent" },
    });
    expect(probe.agentName).toBe("Env Layered Agent");
  });

  it("ignores non-JSON banner noise before the handshake", async () => {
    const agent = writeAcpAgent({ banner: "kimi-cod first run: warming caches..." });
    const probe = await probeAcpAgent({ command: agent, args: ["acp"], cwd: scratch });
    expect(probe.ok).toBe(true);
    expect(probe.agentName).toBe("Fake Kimi");
  });

  it("reports missing_executable when the binary does not exist", async () => {
    const probe = await probeAcpAgent({
      command: join(scratch, "definitely-not-installed"),
      args: ["acp"],
      cwd: scratch,
    });
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe("missing_executable");
  });

  it("reports timeout for an agent that never answers", async () => {
    const agent = writeAcpAgent({ silent: true });
    const probe = await probeAcpAgent({
      command: agent,
      args: ["acp"],
      cwd: scratch,
      timeoutMs: 500,
    });
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe("timeout");
    expect(probe.error).toBe("timed out");
  });

  it("surfaces the agent's stderr when it exits before responding", async () => {
    const agent = writeAcpAgent({
      exitImmediately: { code: 1, stderr: "kimi: not logged in — run kimi login" },
    });
    const probe = await probeAcpAgent({ command: agent, args: ["acp"], cwd: scratch });
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe("handshake_failed");
    expect(probe.error).toContain("not logged in");
  });

  it("keeps identity fields from initialize when session/new fails", async () => {
    // The installed-but-not-authenticated shape: doctor should still show WHAT
    // is installed while explaining why sessions cannot start.
    const agent = writeAcpAgent({ sessionError: { message: "Please run kimi login first" } });
    const probe = await probeAcpAgent({ command: agent, args: ["acp"], cwd: scratch });
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe("handshake_failed");
    expect(probe.error).toContain("kimi login");
    expect(probe.agentName).toBe("Fake Kimi");
    expect(probe.protocolVersion).toBe(1);
  });
});
