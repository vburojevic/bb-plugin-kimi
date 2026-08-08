// The /bin/sh launch line, tested exactly as BB spawns it:
//
//   spawn("/bin/sh", ["-c", LAUNCH_SNIPPET, "kimi-acp", "acp"], { env })
//
// This is the cross-host safety contract: one shared config.json entry must
// run the coalescer where it exists and degrade to the plain CLI everywhere
// else — including hosts with no node, wrappers not yet distributed, and CLI
// paths containing spaces. Every branch is exercised with a real /bin/sh.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";

import { afterAll, describe, expect, it } from "vitest";

import { LAUNCH_SNIPPET, materializeWrapper } from "./wrapper";

const scratch = mkdtempSync(join(tmpdir(), "kimi-snippet-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A stand-in CLI written in POSIX sh, so it runs even where node does not. */
function writeShellCli(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho "REAL:$@"\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** A node fake agent, for asserting the wrapper branch actually coalesces. */
function writeNodeAgent(path: string, lines: string[]): string {
  writeFileSync(
    path,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(lines.join("\n") + "\n")});\n`,
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

function toolUpdate(i: number, status = "in_progress"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status,
        content: [{ type: "content", content: { type: "text", text: `tick ${i}` } }],
      },
    },
  });
}

function runSnippet(options: {
  home: string;
  real: string;
  extraArgs?: string[];
  path?: string;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/bin/sh",
      ["-c", LAUNCH_SNIPPET, "kimi-acp", "acp", ...(options.extraArgs ?? [])],
      {
        timeout: 15_000,
        env: {
          ...process.env,
          HOME: options.home,
          KIMI_ACP_REAL: options.real,
          KIMI_COALESCE_MS: "200",
          ...(options.path === undefined ? {} : { PATH: options.path }),
        },
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

describe("launch snippet", () => {
  it("is valid POSIX shell", async () => {
    await new Promise<void>((resolve, reject) => {
      execFile("/bin/sh", ["-n", "-c", LAUNCH_SNIPPET], (error) =>
        error === null ? resolve() : reject(error),
      );
    });
  });

  it("execs the plain CLI when no wrapper has been materialized", async () => {
    const home = join(scratch, "home-bare");
    mkdirSync(home, { recursive: true });
    const real = writeShellCli(join(scratch, "bin", "kimi"));
    const { code, stdout } = await runSnippet({ home, real });
    expect(code).toBe(0);
    // Positional args flowed through "$@" untouched.
    expect(stdout.trim()).toBe("REAL:acp");
  });

  it("passes extra arguments through either branch", async () => {
    const home = join(scratch, "home-args");
    mkdirSync(home, { recursive: true });
    const real = writeShellCli(join(scratch, "bin", "kimi-args"));
    const { stdout } = await runSnippet({
      home,
      real,
      extraArgs: ["--resume", "session-1"],
    });
    expect(stdout.trim()).toBe("REAL:acp --resume session-1");
  });

  it("handles a CLI path containing spaces", async () => {
    const home = join(scratch, "home-spaces");
    mkdirSync(home, { recursive: true });
    const real = writeShellCli(join(scratch, "dir with spaces", "kimi"));
    const { code, stdout } = await runSnippet({ home, real });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("REAL:acp");
  });

  it("falls back to the plain CLI when node is not on PATH", async () => {
    // A PATH with sh's own essentials but no node. Skip (rather than fail)
    // if this machine keeps a node in a system directory.
    const bare = "/usr/bin:/bin";
    const nodeInBare = await new Promise<boolean>((resolve) => {
      execFile(
        "/bin/sh",
        ["-c", "command -v node >/dev/null 2>&1"],
        { env: { PATH: bare } },
        (error) => resolve(error === null),
      );
    });
    if (nodeInBare) return; // environment cannot express the branch

    const home = join(scratch, "home-no-node");
    materializeWrapper(home); // wrapper present, runtime missing
    const real = writeShellCli(join(scratch, "bin", "kimi-no-node"));
    const { code, stdout } = await runSnippet({ home, real, path: bare });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("REAL:acp");
  });

  it("routes through the coalescer when wrapper and node are both present", async () => {
    const home = join(scratch, "home-wrapped");
    materializeWrapper(home);
    const burst = Array.from({ length: 30 }, (_, i) => toolUpdate(i + 1));
    const real = writeNodeAgent(join(scratch, "node-agent.mjs"), [
      ...burst,
      toolUpdate(31, "completed"),
    ]);

    const { code, stdout } = await runSnippet({ home, real });
    expect(code).toBe(0);
    const updates = stdout.split("\n").filter((line) => line.includes("tool_call_update"));
    // 31 in, 2 out — the coalescer, not the plain CLI, handled the stream.
    expect(updates.length).toBeLessThanOrEqual(3);
    expect(updates.at(-1)).toContain('"completed"');
    expect(updates.at(-1)).toContain("tick 31");
  });
});
