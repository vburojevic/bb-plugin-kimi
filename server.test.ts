// Behavioral tests for the plugin factory against a hand-rolled fake host.
//
// The official @bb/plugin-sdk testing harness is not distributable outside the
// bb repo, so this fake implements exactly the surface server.ts touches:
// settings (with descriptor defaults), rpc/cli/service registration capture,
// logging capture, and a recording bb.sdk whose stubs each test overrides.
// What these tests protect is the ORCHESTRATION: which entry lands in
// config.json, which hosts receive the coalescer, and which command the login
// terminal runs — the wiring a refactor is most likely to silently break.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Mirrors HEALTH_INTERVAL_MS in server.ts — the provider-sync loop period. */
const HEALTH_INTERVAL_MS = 15 * 60_000;
import type { BbPluginApi } from "@bb/plugin-sdk";

import plugin from "./server";

// --- fake host ---------------------------------------------------------------

interface FakeHost {
  bb: BbPluginApi;
  rpcHandlers: Record<string, (input: any) => Promise<any>>;
  cliRun: (argv: string[], ctx: object) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
  services: Record<string, { start: (signal: AbortSignal) => Promise<void> }>;
  logs: { level: string; message: string }[];
  sdkCalls: { path: string; input: unknown }[];
  setSettings: (values: Record<string, unknown>) => Promise<void>;
  dataDir: string;
}

const scratchDirs: string[] = [];

// HERMETICITY: distributeWrapper() materializes the coalescer into the local
// home via node:fs, so without this the suite would overwrite the developer's
// own live ~/.bb/plugins/kimi/acp-coalesce.mjs on every run. os.homedir()
// honours $HOME on POSIX, so redirecting it sandboxes those writes.
const realHome = process.env.HOME;
beforeEach(() => {
  const fakeHome = mkdtempSync(join(tmpdir(), "kimi-fake-home-"));
  scratchDirs.push(fakeHome);
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createFakeHost(options: {
  settings?: Record<string, unknown>;
  sdk?: Record<string, unknown>;
}): FakeHost {
  const dataDir = mkdtempSync(join(tmpdir(), "kimi-server-test-"));
  scratchDirs.push(dataDir);

  const logs: FakeHost["logs"] = [];
  const sdkCalls: FakeHost["sdkCalls"] = [];
  const rpcHandlers: FakeHost["rpcHandlers"] = {};
  const services: FakeHost["services"] = {};
  let cliRun: FakeHost["cliRun"] = () => Promise.reject(new Error("cli not registered"));

  let settingsDefaults: Record<string, unknown> = {};
  const settingsValues: Record<string, unknown> = { ...options.settings };
  const changeListeners: ((next: unknown, prev: unknown) => void)[] = [];

  // Deep-path stubs like "hosts.list"; unstubbed calls fail loudly with the
  // path so a test never silently passes on a default.
  const sdkStubs: Record<string, unknown> = {
    "system.config": () => ({ dataDir, primaryHostId: null }),
    "system.reloadConfig": () => undefined,
    "hosts.list": () => [],
    ...options.sdk,
  };
  function sdkProxy(prefix: string): unknown {
    return new Proxy(
      {},
      {
        get(_target, property: string) {
          const path = prefix === "" ? property : `${prefix}.${property}`;
          if (path in sdkStubs) {
            return async (input: unknown) => {
              sdkCalls.push({ path, input });
              return (sdkStubs[path] as (input: unknown) => unknown)(input);
            };
          }
          return sdkProxy(path);
        },
      },
    );
  }

  const bb = {
    pluginId: "kimi",
    log: Object.fromEntries(
      (["debug", "info", "warn", "error"] as const).map((level) => [
        level,
        (message: string) => logs.push({ level, message }),
      ]),
    ),
    settings: {
      define(descriptors: Record<string, { default?: unknown }>) {
        settingsDefaults = Object.fromEntries(
          Object.entries(descriptors)
            .filter(([, descriptor]) => "default" in descriptor)
            .map(([key, descriptor]) => [key, descriptor.default]),
        );
        return {
          get: async () => ({ ...settingsDefaults, ...settingsValues }),
          onChange: (listener: (next: unknown, prev: unknown) => void) =>
            changeListeners.push(listener),
        };
      },
    },
    rpc: {
      register(_contract: unknown, handlers: Record<string, (input: any) => Promise<any>>) {
        Object.assign(rpcHandlers, handlers);
      },
    },
    cli: {
      register(registration: { run: FakeHost["cliRun"] }) {
        cliRun = registration.run;
      },
    },
    background: {
      service(name: string, service: { start: (signal: AbortSignal) => Promise<void> }) {
        services[name] = service;
      },
      schedule() {},
    },
    status: { needsConfiguration: (message: string) => logs.push({ level: "needs-config", message }) },
    events: { on() {} },
    onDispose() {},
    sdk: sdkProxy(""),
  };

  return {
    bb: bb as unknown as BbPluginApi,
    rpcHandlers,
    cliRun: (argv, ctx) => cliRun(argv, ctx),
    services,
    logs,
    sdkCalls,
    setSettings: async (values) => {
      const previous = { ...settingsDefaults, ...settingsValues };
      Object.assign(settingsValues, values);
      const next = { ...settingsDefaults, ...settingsValues };
      for (const listener of changeListeners) listener(next, previous);
    },
    dataDir,
  };
}

function readConfig(host: FakeHost): Record<string, any> {
  return JSON.parse(readFileSync(join(host.dataDir, "config.json"), "utf8"));
}

function kimiEntry(host: FakeHost): Record<string, any> | undefined {
  return (readConfig(host).customAcpAgents as Record<string, any>[] | undefined)?.find(
    (agent) => agent.id === "kimi",
  );
}

const healthyModels = () => ({
  models: [
    {
      id: "kimi-code/kimi-for-coding",
      displayName: "Kimi for Coding",
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
    },
  ],
  modelLoadError: null,
});

// --- tests -------------------------------------------------------------------

describe("factory", () => {
  it("registers every surface without touching the SDK", async () => {
    const host = createFakeHost({});
    await plugin(host.bb);
    expect(Object.keys(host.rpcHandlers).sort()).toEqual(["login", "status", "sync", "unregister"]);
    expect(Object.keys(host.services)).toEqual(["provider-sync"]);
    // Load safety: nothing may read bb.sdk until a handler or service runs.
    expect(host.sdkCalls).toEqual([]);
  });
});

describe("sync", () => {
  it("writes the wrapped entry and preserves everything else in config.json", async () => {
    const host = createFakeHost({ settings: { showLogo: false } });
    const sibling = { id: "other-agent", displayName: "Other", command: "other", args: ["acp"] };
    writeFileSync(
      join(host.dataDir, "config.json"),
      JSON.stringify({ machineCredential: "keep-me", customAcpAgents: [sibling] }),
      "utf8",
    );
    await plugin(host.bb);

    const first = await host.rpcHandlers.sync!(null);
    expect(first.changed).toBe(true);

    const config = readConfig(host);
    expect(config.machineCredential).toBe("keep-me");
    expect(config.customAcpAgents).toHaveLength(2);
    expect(config.customAcpAgents[0]).toEqual(sibling);

    const entry = kimiEntry(host)!;
    expect(entry.command).toBe("/bin/sh");
    expect(entry.args[1]).toContain("acp-coalesce.mjs");
    expect(entry.env).toEqual({ KIMI_ACP_REAL: "kimi" });

    const reloads = () => host.sdkCalls.filter((call) => call.path === "system.reloadConfig");
    expect(reloads()).toHaveLength(1);

    // Idempotency: a second sync neither rewrites nor reloads.
    const second = await host.rpcHandlers.sync!(null);
    expect(second.changed).toBe(false);
    expect(reloads()).toHaveLength(1);
  });

  it("registers the plain CLI when coalescing is disabled", async () => {
    const host = createFakeHost({ settings: { showLogo: false, coalesceProgress: false } });
    await plugin(host.bb);
    await host.rpcHandlers.sync!(null);

    const entry = kimiEntry(host)!;
    expect(entry).toEqual({
      id: "kimi",
      displayName: "Kimi Code",
      command: "kimi",
      args: ["acp"],
    });
  });

  it("re-reconciles on a settings change", async () => {
    const host = createFakeHost({ settings: { showLogo: false } });
    await plugin(host.bb);
    await host.rpcHandlers.sync!(null);
    expect(kimiEntry(host)!.displayName).toBe("Kimi Code");

    await host.setSettings({ displayName: "Kimi (staging)" });
    await expect.poll(() => kimiEntry(host)?.displayName).toBe("Kimi (staging)");
  });
});

/**
 * A host fake wired for distribution: a fresh remote machine whose
 * `.bb/plugins` tree does not exist yet, so it fails a non-recursive mkdir and
 * a write without createParents — exactly the shape that made distribution
 * silently no-op on real hosts.
 */
function distributionSdk(options: { existingContent?: string } = {}) {
  const files = new Map<string, string>();
  const dirs = new Set<string>(["/Users/h1", "/Users/h1/.bb"]);
  const calls: { op: string; input: any }[] = [];
  if (options.existingContent !== undefined) {
    files.set("/Users/h1/.bb/plugins/kimi/acp-coalesce.mjs", options.existingContent);
    dirs.add("/Users/h1/.bb/plugins");
    dirs.add("/Users/h1/.bb/plugins/kimi");
  }
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
  return {
    files,
    calls,
    sdk: {
      "hosts.list": () => [{ id: "h1", name: "laptop", status: "connected" }],
      "hosts.directory": () => ({ directory: "/Users/h1" }),
      "files.read": (input: { path: string }) => {
        calls.push({ op: "read", input });
        const content = files.get(input.path);
        if (content === undefined) throw new Error(`404 ${input.path}`);
        return { content, sha256: "x", sizeBytes: content.length };
      },
      "files.mkdir": (input: { path: string; recursive?: boolean }) => {
        calls.push({ op: "mkdir", input });
        if (input.recursive !== true && !dirs.has(parentOf(input.path))) {
          throw new Error(`ENOENT: missing parent for ${input.path}`);
        }
        const segments = input.path.split("/");
        for (let i = 3; i <= segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
        return {};
      },
      "files.write": (input: { path: string; content: string; createParents?: boolean }) => {
        calls.push({ op: "write", input });
        if (input.createParents !== true && !dirs.has(parentOf(input.path))) {
          throw new Error(`404 Path does not exist: ${parentOf(input.path)}`);
        }
        files.set(input.path, input.content);
        return { outcome: "written" };
      },
      "files.remove": (input: { path: string }) => {
        calls.push({ op: "remove", input });
        files.delete(input.path);
        return {};
      },
      "files.move": (input: { sourcePath: string; destinationPath: string }) => {
        calls.push({ op: "move", input });
        const content = files.get(input.sourcePath);
        if (content === undefined) throw new Error("missing source");
        if (files.has(input.destinationPath)) throw new Error("destination exists");
        files.delete(input.sourcePath);
        files.set(input.destinationPath, content);
        return {};
      },
      "providers.models": healthyModels,
    },
  };
}

describe("wrapper distribution", () => {
  it("creates missing parent directories on a fresh host", async () => {
    // Regression: mkdir defaulted to non-recursive and write to
    // createParents:false, so on a host without ~/.bb/plugins BOTH calls
    // failed and the machine ran the plain CLI forever while `bb kimi status`
    // reported coalescing as on.
    const fixture = distributionSdk();
    const host = createFakeHost({ settings: { showLogo: false }, sdk: fixture.sdk });
    await plugin(host.bb);
    await host.rpcHandlers.sync!(null);

    await expect
      .poll(() => fixture.files.get("/Users/h1/.bb/plugins/kimi/acp-coalesce.mjs"))
      .toBeDefined();
    expect(
      fixture.files.get("/Users/h1/.bb/plugins/kimi/acp-coalesce.mjs")!.startsWith("#!/usr/bin/env node"),
    ).toBe(true);
    expect(host.logs.some((log) => log.level === "warn")).toBe(false);
  });

  it("publishes atomically: the executed path never holds a partial write", async () => {
    const fixture = distributionSdk();
    const host = createFakeHost({ settings: { showLogo: false }, sdk: fixture.sdk });
    await plugin(host.bb);
    await host.rpcHandlers.sync!(null);
    await expect
      .poll(() => fixture.calls.some((call) => call.op === "move"))
      .toBe(true);

    const target = "/Users/h1/.bb/plugins/kimi/acp-coalesce.mjs";
    const write = fixture.calls.find((call) => call.op === "write")!;
    // Content lands on a staging path and is renamed into place, so the
    // launch snippet's `-f` test can never see a half-written script.
    expect(write.input.path).not.toBe(target);
    expect(write.input.path.startsWith(target)).toBe(true);
    const move = fixture.calls.find((call) => call.op === "move")!;
    expect(move.input.sourcePath).toBe(write.input.path);
    expect(move.input.destinationPath).toBe(target);
    // Confinement is applied on every mutation, not just the write.
    for (const call of fixture.calls) expect(call.input.rootPath).toBe("/Users/h1");
  });

  it("skips hosts that already carry the current wrapper", async () => {
    const current = (await import("./lib/wrapper")).WRAPPER_SOURCE;
    const fixture = distributionSdk({ existingContent: current });
    const host = createFakeHost({ settings: { showLogo: false }, sdk: fixture.sdk });
    await plugin(host.bb);
    await host.rpcHandlers.sync!(null);
    await expect.poll(() => fixture.calls.some((call) => call.op === "read")).toBe(true);
    // Steady state is one read per host — no rewrite, no rename churn.
    expect(fixture.calls.filter((call) => call.op === "write")).toHaveLength(0);
    expect(fixture.calls.filter((call) => call.op === "move")).toHaveLength(0);
  });

  it("replaces a stale wrapper left by an older plugin version", async () => {
    const fixture = distributionSdk({ existingContent: "// ancient wrapper\n" });
    const host = createFakeHost({ settings: { showLogo: false }, sdk: fixture.sdk });
    await plugin(host.bb);
    await host.rpcHandlers.sync!(null);
    await expect
      .poll(() => fixture.files.get("/Users/h1/.bb/plugins/kimi/acp-coalesce.mjs"))
      .not.toBe("// ancient wrapper\n");
  });

  it("targets connected hosts only and keeps going past failures", async () => {
    const writes: { hostId: string; path: string; content: string }[] = [];
    const host = createFakeHost({
      settings: { showLogo: false },
      sdk: {
        "hosts.list": () => [
          { id: "h1", name: "laptop", status: "connected" },
          { id: "h2", name: "offline-box", status: "disconnected" },
          { id: "h3", name: "flaky-mini", status: "connected" },
        ],
        "hosts.directory": ({ hostId }: { hostId: string }) => ({
          directory: `/Users/${hostId}`,
        }),
        "files.read": () => {
          throw new Error("404 no wrapper yet");
        },
        "files.mkdir": () => ({}),
        "files.write": (input: { hostId: string; path: string; content: string }) => {
          if (input.hostId === "h3") throw new Error("daemon unreachable");
          writes.push(input);
          return { outcome: "written" };
        },
        "files.remove": () => ({}),
        "files.move": () => ({}),
        "providers.models": healthyModels,
      },
    });
    await plugin(host.bb);
    await host.rpcHandlers.sync!(null);

    // Distribution is deliberately fire-and-forget; wait for it to settle.
    await expect.poll(() => writes).toHaveLength(1);
    expect(writes[0]!.hostId).toBe("h1");
    expect(writes[0]!.path.startsWith("/Users/h1/.bb/plugins/kimi/acp-coalesce.mjs")).toBe(true);
    expect(writes[0]!.content.startsWith("#!/usr/bin/env node")).toBe(true);

    // The disconnected host was never touched, on any surface.
    expect(host.sdkCalls.some((call) => (call.input as any)?.hostId === "h2")).toBe(false);

    // The flaky host degraded to a warning, not a failure.
    await expect
      .poll(() =>
        host.logs.some(
          (log) => log.level === "warn" && log.message.includes("flaky-mini"),
        ),
      )
      .toBe(true);
  });

  it("collapses concurrent distribution runs into one", async () => {
    // reconcile() and the service sweep both distribute and do overlap in
    // practice. Without single-flight they stage to the same path and race on
    // the rename, so the loser logged a spurious ENOENT against a host that
    // was in fact fine.
    const fixture = distributionSdk();
    const host = createFakeHost({ settings: { showLogo: false }, sdk: fixture.sdk });
    await plugin(host.bb);

    await Promise.all([
      host.rpcHandlers.sync!(null),
      host.rpcHandlers.sync!(null),
      host.rpcHandlers.sync!(null),
    ]);
    await expect
      .poll(() => fixture.calls.some((call) => call.op === "move"))
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fixture.calls.filter((call) => call.op === "move")).toHaveLength(1);
    expect(fixture.files.get("/Users/h1/.bb/plugins/kimi/acp-coalesce.mjs")).toBeDefined();
    expect(host.logs.filter((log) => log.level === "warn")).toHaveLength(0);
  });

  it("re-distributes on the service loop, reaching hosts that connect later", async () => {
    // The service is the only path that runs after load, so a machine enrolled
    // or reconnected later depends entirely on this sweep.
    const fixture = distributionSdk();
    let connected = false;
    const host = createFakeHost({
      settings: { showLogo: false },
      sdk: {
        ...fixture.sdk,
        "hosts.list": () =>
          connected ? [{ id: "h1", name: "laptop", status: "connected" }] : [],
      },
    });
    await plugin(host.bb);

    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const running = host.services["provider-sync"]!.start(controller.signal);

      // Host was offline at load: nothing written.
      await vi.advanceTimersByTimeAsync(100);
      expect(fixture.files.size).toBe(0);

      // It connects afterwards. The next sweep is what must reach it — there
      // is no other code path that runs after load.
      connected = true;
      await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS + 1_000);
      expect(fixture.files.get("/Users/h1/.bb/plugins/kimi/acp-coalesce.mjs")).toBeDefined();

      controller.abort();
      await vi.advanceTimersByTimeAsync(100);
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips distribution entirely when coalescing is off", async () => {
    const host = createFakeHost({
      settings: { showLogo: false, coalesceProgress: false },
      sdk: {
        "hosts.list": () => [{ id: "h1", name: "laptop", status: "connected" }],
        "providers.models": healthyModels,
      },
    });
    await plugin(host.bb);
    await host.rpcHandlers.sync!(null);
    // Settle any stray async work, then confirm no file surface was touched.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.sdkCalls.some((call) => call.path.startsWith("files."))).toBe(false);
  });
});

describe("host health", () => {
  function healthFake(options: { hold?: boolean } = {}) {
    let release: (() => void) | null = null;
    const gate = options.hold
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve();
    const probed: string[] = [];
    return {
      probed,
      release: () => release?.(),
      sdk: {
        "hosts.list": () => [
          { id: "h1", name: "one", status: "connected" },
          { id: "h2", name: "two", status: "connected" },
        ],
        "providers.models": async ({ hostId }: { hostId: string }) => {
          probed.push(hostId);
          await gate;
          return healthyModels();
        },
      },
    };
  }

  it("collapses concurrent reads into a single fan-out", async () => {
    // Each providers.models call can spawn a full ACP handshake on a machine,
    // so four overlapping status reads used to mean eight handshakes.
    const fake = healthFake();
    const host = createFakeHost({ settings: { showLogo: false }, sdk: fake.sdk });
    await plugin(host.bb);

    await Promise.all([
      host.rpcHandlers.status!(null),
      host.rpcHandlers.status!(null),
      host.rpcHandlers.status!(null),
      host.rpcHandlers.status!(null),
    ]);
    expect(fake.probed).toEqual(["h1", "h2"]);
  });

  it("probes machines concurrently rather than one after another", async () => {
    const fake = healthFake({ hold: true });
    const host = createFakeHost({ settings: { showLogo: false }, sdk: fake.sdk });
    await plugin(host.bb);

    const reading = host.rpcHandlers.status!(null);
    // Both machines must be in flight while the first is still unanswered; a
    // sequential loop would have reached only h1.
    await expect.poll(() => fake.probed).toEqual(["h1", "h2"]);
    fake.release();
    await reading;
  });

  it("does not let an in-flight read publish a stale answer after invalidation", async () => {
    // The generation guard: a read that started before `sync` must never
    // overwrite the fresh result with its older one and pin it for a TTL.
    const fake = healthFake({ hold: true });
    const host = createFakeHost({ settings: { showLogo: false }, sdk: fake.sdk });
    await plugin(host.bb);

    const stale = host.rpcHandlers.status!(null);
    await expect.poll(() => fake.probed.length).toBe(2);

    // sync() invalidates and re-measures. It must not be awaited before the
    // gate opens — its own fan-out waits on the same gate.
    const resync = host.rpcHandlers.sync!(null);
    await expect.poll(() => fake.probed.length).toBe(4);
    fake.release();
    await Promise.all([stale, resync]);

    const afterProbes = fake.probed.length;
    await host.rpcHandlers.status!(null);
    // The post-invalidation result is cached, so this read is served from it
    // rather than re-probing — proving the abandoned run did not clobber it
    // (a stale publication would have been overwritten, not cached).
    expect(fake.probed.length).toBe(afterProbes);
  });
});

describe("status", () => {
  it("reports the real CLI command and the coalescing flag", async () => {
    const host = createFakeHost({ settings: { showLogo: false } });
    await plugin(host.bb);
    await host.rpcHandlers.sync!(null);

    const status = await host.rpcHandlers.status!(null);
    // The app renders "<command> acp" — it must name the CLI, not the shim.
    expect(status.command).toBe("kimi");
    expect(status.coalescing).toBe(true);
    expect(status.registered).toBe(true);
    expect((status.entry as Record<string, unknown>).command).toBe("/bin/sh");
  });

  it("reflects an unmanaged provider", async () => {
    const host = createFakeHost({ settings: { showLogo: false, manageProvider: false } });
    await plugin(host.bb);
    const status = await host.rpcHandlers.status!(null);
    expect(status.managed).toBe(false);
    expect(status.coalescing).toBe(false);
    expect(status.warning).toContain("Provider management is off");
  });

  it("prints the coalescing line in the CLI status output", async () => {
    const host = createFakeHost({ settings: { showLogo: false } });
    await plugin(host.bb);
    const result = await host.cliRun(["status"], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("coalescing   on");
    expect(result.stdout).toContain("command      kimi acp");
  });
});

describe("login", () => {
  it("always launches the real CLI, never the wrapper shim", async () => {
    const terminals: { command: string }[] = [];
    const host = createFakeHost({
      settings: { showLogo: false, cliPath: "/opt/tools dir/kimi" },
      sdk: {
        "system.config": () => ({
          dataDir: host.dataDir,
          primaryHostId: "h1",
        }),
        "hosts.list": () => [{ id: "h1", name: "laptop", status: "connected" }],
        "terminals.create": (input: { start: { command: string } }) => {
          terminals.push({ command: input.start.command });
          return { id: "term_1" };
        },
        "providers.models": healthyModels,
      },
    });
    await plugin(host.bb);

    const result = await host.rpcHandlers.login!({});
    expect(result.terminalId).toBe("term_1");
    expect(terminals).toHaveLength(1);
    // Single-quoted because of the space; a wrapper shim here would break the
    // interactive device-code flow.
    expect(terminals[0]!.command).toBe("'/opt/tools dir/kimi' login");
    expect(terminals[0]!.command).not.toContain("/bin/sh");
  });

  it("neutralizes shell metacharacters in a configured CLI path", async () => {
    const terminals: { command: string }[] = [];
    const host = createFakeHost({
      settings: { showLogo: false, cliPath: "/tmp/$(touch /tmp/pwned)/kimi" },
      sdk: {
        "system.config": () => ({ dataDir: host.dataDir, primaryHostId: "h1" }),
        "hosts.list": () => [{ id: "h1", name: "laptop", status: "connected" }],
        "terminals.create": (input: { start: { command: string } }) => {
          terminals.push({ command: input.start.command });
          return { id: "term_1" };
        },
        "providers.models": healthyModels,
      },
    });
    await plugin(host.bb);
    await host.rpcHandlers.login!({});
    // The path travels as one inert word — the $() can never execute.
    expect(terminals[0]!.command).toBe("'/tmp/$(touch /tmp/pwned)/kimi' login");
  });
});

describe("unregister", () => {
  it("removes only the kimi entry", async () => {
    const host = createFakeHost({ settings: { showLogo: false } });
    const sibling = { id: "other-agent", displayName: "Other", command: "other", args: ["acp"] };
    writeFileSync(
      join(host.dataDir, "config.json"),
      JSON.stringify({ customAcpAgents: [sibling] }),
      "utf8",
    );
    await plugin(host.bb);
    await host.rpcHandlers.sync!(null);
    expect(readConfig(host).customAcpAgents).toHaveLength(2);

    const result = await host.rpcHandlers.unregister!(null);
    expect(result.changed).toBe(true);
    expect(readConfig(host).customAcpAgents).toEqual([sibling]);
  });
});
