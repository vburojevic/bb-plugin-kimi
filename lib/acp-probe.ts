// A minimal ACP client used only for diagnostics (`bb kimi doctor`).
//
// It speaks just enough of the Agent Client Protocol to learn what BB's own
// bridge learns at session start: the agent's name/version, its advertised auth
// methods, and its session config options (`model`, `thought_level`, `mode`).
//
// Scope note: this spawns the CLI from the BB *server* process, so it only ever
// describes the server's own host. Per-host availability comes from
// `bb.sdk.providers.models({ hostId })`, which routes through each host daemon.

import { spawn } from "node:child_process";

export interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  currentValue?: string;
  options?: { value: string; name?: string; description?: string }[];
}

export interface AcpAuthMethod {
  id: string;
  name?: string;
  type?: string;
  description?: string;
}

export interface AcpProbeResult {
  ok: boolean;
  /** Set when the handshake could not be completed. */
  error: string | null;
  /** "missing_executable" when the binary could not be spawned at all. */
  code: "missing_executable" | "handshake_failed" | "timeout" | null;
  agentName: string | null;
  agentVersion: string | null;
  protocolVersion: number | null;
  authMethods: AcpAuthMethod[];
  configOptions: AcpConfigOption[];
}

interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

// A warm handshake takes ~4-6s. The first run after a CLI upgrade is slower
// because Kimi does one-time setup, so this is generous enough not to report a
// false failure there.
const DEFAULT_TIMEOUT_MS = 45_000;

function failure(
  code: NonNullable<AcpProbeResult["code"]>,
  error: string,
): AcpProbeResult {
  return {
    ok: false,
    error,
    code,
    agentName: null,
    agentVersion: null,
    protocolVersion: null,
    authMethods: [],
    configOptions: [],
  };
}

/**
 * Run `initialize` + `session/new` against the Kimi Code ACP server and report
 * what it advertises. Always resolves — never throws — so callers can render a
 * diagnostic instead of handling an exception.
 */
export async function probeAcpAgent(args: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}): Promise<AcpProbeResult> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(args.command, args.args, {
      cwd: args.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
  } catch (error) {
    return failure("missing_executable", error instanceof Error ? error.message : String(error));
  }

  const pending = new Map<number, (message: JsonRpcMessage) => void>();
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  let spawnError: string | null = null;

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue; // Non-JSON banner lines are not protocol traffic.
      }
      if (typeof message.id === "number") {
        const resolve = pending.get(message.id);
        if (resolve) {
          pending.delete(message.id);
          resolve(message);
        }
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
  });
  child.on("error", (error: Error) => {
    spawnError = error.message;
    for (const resolve of pending.values()) resolve({ error: { message: error.message } });
    pending.clear();
  });
  child.on("exit", () => {
    for (const resolve of pending.values()) {
      resolve({ error: { message: stderr.trim() || "ACP agent exited before responding." } });
    }
    pending.clear();
  });

  const call = (method: string, params: unknown): Promise<JsonRpcMessage> => {
    const id = nextId++;
    return new Promise<JsonRpcMessage>((resolve) => {
      pending.set(id, resolve);
      try {
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        pending.delete(id);
        resolve({ error: { message: error instanceof Error ? error.message : String(error) } });
      }
    });
  };

  const timer = setTimeout(() => {
    for (const resolve of pending.values()) resolve({ error: { message: "timed out" } });
    pending.clear();
  }, timeoutMs);

  try {
    const initialize = await call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });

    if (spawnError !== null) {
      const message = spawnError as string;
      return failure(
        message.includes("ENOENT") ? "missing_executable" : "handshake_failed",
        message,
      );
    }
    if (initialize.error) {
      const message = initialize.error.message ?? "initialize failed";
      return failure(message === "timed out" ? "timeout" : "handshake_failed", message);
    }

    const initResult = (initialize.result ?? {}) as {
      protocolVersion?: number;
      authMethods?: AcpAuthMethod[];
      agentInfo?: { name?: string; version?: string };
    };

    // session/new is what surfaces the model catalog — and what fails loudly
    // when the CLI is installed but not logged in.
    const session = await call("session/new", { cwd: args.cwd, mcpServers: [] });
    const sessionResult = (session.result ?? {}) as { configOptions?: AcpConfigOption[] };

    return {
      ok: !session.error,
      error: session.error ? (session.error.message ?? "session/new failed") : null,
      code: session.error ? "handshake_failed" : null,
      agentName: initResult.agentInfo?.name ?? null,
      agentVersion: initResult.agentInfo?.version ?? null,
      protocolVersion: initResult.protocolVersion ?? null,
      authMethods: initResult.authMethods ?? [],
      configOptions: sessionResult.configOptions ?? [],
    };
  } finally {
    clearTimeout(timer);
    terminate(child);
  }
}

/**
 * Kill the probe child without any chance of a leak.
 *
 * A bare `child.kill()` once leaked a `kimi acp` process under the BB server
 * for seven hours: a child that is busy (e.g. first-run setup) can ride out a
 * single SIGTERM. Close stdin so the agent sees EOF, send SIGTERM, and follow
 * with SIGKILL if it has not exited shortly after. The escalation timer is
 * unref'd so it never keeps the server process alive.
 */
function terminate(child: ReturnType<typeof spawn>): void {
  try {
    child.stdin?.end();
  } catch {
    // Already closed.
  }
  child.kill("SIGTERM");
  if (child.exitCode !== null || child.signalCode !== null) return;
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, 3000);
  escalation.unref();
  child.once("exit", () => clearTimeout(escalation));
}

/** The `model` config option, matching how BB's bridge locates it. */
export function findModelOption(options: AcpConfigOption[]): AcpConfigOption | undefined {
  return options.find((o) => o.category === "model") ?? options.find((o) => o.id === "model");
}

export function findThinkingOption(options: AcpConfigOption[]): AcpConfigOption | undefined {
  return options.find((o) => o.category === "thought_level");
}
