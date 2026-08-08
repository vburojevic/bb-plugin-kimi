// bb-plugin-kimi — makes Kimi Code a first-class provider in BB.
//
// How this works, and why it is shaped this way:
//
// BB's plugin API has no surface for registering an agent provider — providers
// are either built in (codex, claude-code, pi) or declared as custom ACP agents
// in BB's data-dir `config.json`. Kimi Code's CLI speaks the Agent Client
// Protocol (`kimi acp`), so this plugin owns that declaration end to end:
// it writes the entry, hot-reloads BB's config so `acp-kimi` appears without an
// app restart, watches per-host health, and removes the entry on request.
//
// Everything Kimi advertises over ACP — its model catalog, thinking control and
// permission prompts — BB's own bridge consumes natively, so the entry stays
// minimal and there is no model list to keep in sync here.

import { homedir } from "node:os";
import { dirname } from "node:path";

import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

import {
  buildDesiredEntry,
  findAgent,
  readConfigFile,
  removeAgent,
  upsertAgent,
  writeConfigFile,
  type CustomAcpAgentEntry,
} from "./lib/agent-config";
import { findModelOption, findThinkingOption, probeAcpAgent } from "./lib/acp-probe";
import {
  collectReasoningLevels,
  describeLoadError,
  offersReasoningChoice,
  resolveHostErrorCode,
} from "./lib/health";
import { materializeLogo, pluginDataDir } from "./lib/logo";
import { shellQuote } from "./lib/shell-quote";
import {
  WRAPPER_HOME_RELATIVE_PATH,
  WRAPPER_SOURCE,
  materializeWrapper,
} from "./lib/wrapper";
import {
  candidateSkillRoots,
  describeRoot,
  selectActiveRoots,
  skillNamesFromPaths,
  type SkillRootCandidate,
} from "./lib/skills";
import { describeVersionGap, exposesReasoningLevels } from "./lib/version";

/** Custom ACP agent id `kimi` ⇒ BB provider id `acp-kimi`. */
const AGENT_ID = "kimi";
export const PROVIDER_ID = `acp-${AGENT_ID}`;

const DEFAULT_COMMAND = "kimi";
const HEALTH_INTERVAL_MS = 15 * 60_000;

const modelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  isDefault: z.boolean(),
  reasoningEfforts: z.array(z.string()),
});

const hostHealthSchema = z.object({
  hostId: z.string(),
  hostName: z.string(),
  status: z.string(),
  available: z.boolean(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  models: z.array(modelSchema),
  /** Union of reasoning levels this host's CLI advertises. */
  reasoningLevels: z.array(z.string()),
  /** False when the CLI advertises no selectable levels (usually an old build). */
  offersReasoningChoice: z.boolean(),
});

const statusSchema = z.object({
  managed: z.boolean(),
  registered: z.boolean(),
  providerId: z.string(),
  command: z.string(),
  displayName: z.string(),
  configPath: z.string(),
  entry: z.record(z.string(), z.unknown()).nullable(),
  hosts: z.array(hostHealthSchema),
  warning: z.string().nullable(),
  /** Whether tool-call progress coalescing is routed through the wrapper. */
  coalescing: z.boolean(),
});

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  sync: {
    input: z.null(),
    output: z.object({ changed: z.boolean(), status: statusSchema }),
  },
  unregister: {
    input: z.null(),
    output: z.object({ changed: z.boolean() }),
  },
  login: {
    input: z.object({ hostId: z.string().optional() }),
    output: z.object({ terminalId: z.string(), hostId: z.string(), hostName: z.string() }),
  },
});

type ModelInfo = z.infer<typeof modelSchema>;
type HostHealth = z.infer<typeof hostHealthSchema>;
type Status = z.infer<typeof statusSchema>;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    cliPath: {
      type: "string",
      label: "Kimi Code CLI path",
      default: "",
    },
    displayName: {
      type: "string",
      label: "Provider display name",
      default: "Kimi Code",
    },
    manageProvider: {
      type: "boolean",
      label: "Register the Kimi Code provider",
      default: true,
    },
    coalesceProgress: {
      type: "boolean",
      label: "Coalesce tool-call progress updates",
      description:
        "Kimi streams a progress snapshot per output tick and BB persists each one; " +
        "long sessions can write hundreds of megabytes of events and stall BB. " +
        "This routes the agent through a small proxy that keeps at most ~2 " +
        "snapshots per second per tool call, losslessly.",
      default: true,
    },
    showLogo: {
      type: "boolean",
      label: "Use the bundled Kimi logo",
      default: true,
    },
  });

  // --- resolution helpers -------------------------------------------------

  async function resolveDataDir(): Promise<string> {
    const config = await bb.sdk.system.config();
    return config.dataDir;
  }

  /** The CLI itself — what `kimi login` runs and what the wrapper ultimately execs. */
  async function resolveRealCommand(): Promise<string> {
    const values = await settings.get();
    const trimmedPath = values.cliPath.trim();
    // A bare command resolves per host through the host daemon's PATH, which
    // is what keeps one shared config.json valid across machines with
    // different install locations. An absolute override is opt-in.
    return trimmedPath.length > 0 ? trimmedPath : DEFAULT_COMMAND;
  }

  async function resolveDesiredEntry(): Promise<CustomAcpAgentEntry> {
    const values = await settings.get();
    const dataDir = await resolveDataDir();
    const displayName = values.displayName.trim() || "Kimi Code";
    const logo = values.showLogo
      ? materializeLogo(pluginDataDir(dataDir, bb.pluginId))
      : undefined;
    return buildDesiredEntry({
      id: AGENT_ID,
      displayName,
      command: await resolveRealCommand(),
      logo,
      coalesce: values.coalesceProgress,
    });
  }

  // Distribution is triggered from several places (load, every sync, the
  // service sweep, a settings change) and they overlap in practice. Two
  // concurrent runs would stage to the same path and race on the rename, with
  // the loser logging a spurious ENOENT. Single-flight collapses them: a
  // caller arriving mid-run joins the run already in progress.
  let distributionInFlight: Promise<void> | null = null;
  function distributeWrapperOnce(): Promise<void> {
    if (distributionInFlight !== null) return distributionInFlight;
    const run = distributeWrapper().finally(() => {
      if (distributionInFlight === run) distributionInFlight = null;
    });
    distributionInFlight = run;
    return run;
  }

  /**
   * Put the coalescer where the launch snippet looks for it —
   * `$HOME/.bb/plugins/kimi/acp-coalesce.mjs` on every connected machine.
   *
   * Server-local via node:fs (the guaranteed baseline), remote hosts through
   * `bb.sdk.files` best-effort with a deadline: a host that is slow or
   * unreachable simply keeps running the plain CLI until the next sync, which
   * the launch snippet makes safe by construction.
   */
  async function distributeWrapper(): Promise<void> {
    try {
      materializeWrapper(homedir());
    } catch (error) {
      bb.log.warn(
        `could not materialize the coalescer locally: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const withDeadline = <T,>(work: Promise<T>): Promise<T | null> =>
      Promise.race([
        work,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
      ]);
    const hosts = await bb.sdk.hosts.list();
    for (const host of hosts) {
      if (host.status !== "connected") continue;
      try {
        const resolved = await withDeadline(bb.sdk.hosts.directory({ hostId: host.id }));
        const home = resolved?.directory;
        if (home === undefined || home === null || home.length === 0) {
          bb.log.warn(`coalescer not materialized on ${host.name}: home directory unresolved`);
          continue;
        }
        const target = `${home}/${WRAPPER_HOME_RELATIVE_PATH}`;
        // Skip a host that already has this exact content: distribution runs
        // on every sync and on a timer, and the common case should cost one
        // read rather than a write plus a rename.
        const existing = await withDeadline(
          bb.sdk.files
            .read({ hostId: host.id, path: target, rootPath: home })
            .catch(() => null),
        );
        if (existing !== null && existing?.content === WRAPPER_SOURCE) continue;

        try {
          // `recursive` defaults to false, and on a freshly enrolled host
          // neither `.bb/plugins` nor `.bb/plugins/kimi` exists — without this
          // the mkdir fails, the write then fails too, and the host silently
          // runs the plain CLI forever while status claims coalescing is on.
          await withDeadline(
            bb.sdk.files.mkdir({
              hostId: host.id,
              path: dirname(target),
              rootPath: home,
              recursive: true,
            }),
          );
        } catch {
          // The write below reports the real failure, with the better message.
        }
        // Write to a temp sibling, then move into place. `bb` executes this
        // file via the launch snippet's `-f` test, which cannot tell a
        // half-written script from a complete one, so the file at the real
        // path must only ever be complete.
        const staging = `${target}.incoming`;
        const written = await withDeadline(
          bb.sdk.files.write({
            hostId: host.id,
            path: staging,
            // Confinement guard: even a corrupted home value can only ever
            // land this write inside that home, never elsewhere on the host.
            rootPath: home,
            content: WRAPPER_SOURCE,
            createParents: true,
            mode: 0o644,
          }),
        );
        if (written === null) {
          bb.log.warn(`coalescer not materialized on ${host.name}: timed out`);
          continue;
        }
        // `move` refuses to replace an existing destination, so clear the old
        // copy first. The window between the two is covered by the snippet's
        // plain-CLI fallback.
        try {
          await withDeadline(
            bb.sdk.files.remove({ hostId: host.id, path: target, rootPath: home }),
          );
        } catch {
          // Nothing to replace on a first install.
        }
        await withDeadline(
          bb.sdk.files.move({
            hostId: host.id,
            sourcePath: staging,
            destinationPath: target,
            rootPath: home,
          }),
        );
        bb.log.info(`coalescer materialized on ${host.name}`);
      } catch (error) {
        bb.log.warn(
          `coalescer not materialized on ${host.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Write the entry into config.json and hot-reload BB's config.
   *
   * Idempotent: an unchanged entry writes nothing and skips the reload, so
   * plugin reloads never disturb a running Kimi thread.
   */
  async function reconcile(): Promise<{ changed: boolean; entry: CustomAcpAgentEntry | null }> {
    const values = await settings.get();
    if (!values.manageProvider) {
      return { changed: false, entry: null };
    }
    // Fire-and-forget on purpose: distribution is idempotent and the snippet
    // degrades to the plain CLI wherever the file has not landed yet, so
    // registration never waits on a slow host.
    if (values.coalesceProgress) {
      void distributeWrapperOnce().catch((error: unknown) => {
        bb.log.warn(
          `coalescer distribution failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    const dataDir = await resolveDataDir();
    const desired = await resolveDesiredEntry();
    const current = readConfigFile(dataDir);
    const { config, changed } = upsertAgent(current, desired);
    if (!changed) return { changed: false, entry: desired };

    writeConfigFile(dataDir, config);
    await bb.sdk.system.reloadConfig();
    bb.log.info(`registered provider ${PROVIDER_ID} (command: ${desired.command})`);
    return { changed: true, entry: desired };
  }

  async function unregister(): Promise<boolean> {
    const dataDir = await resolveDataDir();
    const { config, changed } = removeAgent(readConfigFile(dataDir), AGENT_ID);
    if (!changed) return false;
    writeConfigFile(dataDir, config);
    await bb.sdk.system.reloadConfig();
    bb.log.info(`removed provider ${PROVIDER_ID}`);
    return true;
  }

  // --- health -------------------------------------------------------------

  // Host health fans out `providers.models` to every connected machine, and a
  // daemon-side cache miss there spawns a full `kimi acp` handshake on that
  // machine. The settings panel, `bb kimi status`, sync, and doctor all read
  // health, so an uncached read amplifies into repeated agent spawns under
  // load. A short TTL keeps every status surface cheap; `sync` and settings
  // changes bypass it via `invalidateHealth()` so corrective actions always
  // re-measure.
  const HEALTH_CACHE_TTL_MS = 30_000;
  let healthCache: { at: number; results: HostHealth[] } | null = null;
  // The TTL only helps callers arriving AFTER a read completes. The settings
  // panel, `bb kimi status`, doctor and the service sweep overlap while the
  // cache is cold, and each overlapping caller re-ran the whole fan-out —
  // four concurrent reads issued eight `providers.models` calls, each able to
  // spawn a full ACP handshake on a machine. Joining the run already in
  // progress collapses them. This removes redundant work, not latency: the
  // duplicates already ran concurrently.
  let healthInFlight: Promise<HostHealth[]> | null = null;
  // Bumped by every invalidation. Without it, a read that started BEFORE a
  // corrective action would publish its now-stale answer when it lands,
  // clobbering the fresh result `sync` just wrote and pinning the stale one
  // for a whole TTL — breaking the "corrective actions always re-measure"
  // contract above. An abandoned run still answers its own caller; it just
  // never touches the cache.
  let healthGeneration = 0;

  function invalidateHealth(): void {
    healthCache = null;
    healthInFlight = null;
    healthGeneration++;
  }

  async function readHostHealth(): Promise<HostHealth[]> {
    if (healthCache !== null && Date.now() - healthCache.at < HEALTH_CACHE_TTL_MS) {
      return healthCache.results;
    }
    if (healthInFlight !== null) return healthInFlight;
    const generation = healthGeneration;
    const run = readHostHealthUncached()
      .then((results) => {
        if (generation === healthGeneration) healthCache = { at: Date.now(), results };
        return results;
      })
      .finally(() => {
        if (healthInFlight === run) healthInFlight = null;
      });
    healthInFlight = run;
    return run;
  }

  /**
   * Per-host availability, read through BB's own provider resolution so the
   * answer reflects each host daemon's PATH rather than the server's.
   */
  async function readHostHealthUncached(): Promise<HostHealth[]> {
    const hosts = await bb.sdk.hosts.list();
    // One handshake per machine, so probing them concurrently adds no load to
    // any single machine — the sequential loop only ever made the user wait
    // for the SUM of every machine's handshake, which grows with the fleet.
    // Promise.all preserves host order.
    return Promise.all(hosts.map(readOneHostHealth));
  }

  async function readOneHostHealth(host: {
    id: string;
    name: string;
    status: string;
  }): Promise<HostHealth> {
    if (host.status !== "connected") {
      return {
        hostId: host.id,
        hostName: host.name,
        status: host.status,
        available: false,
        errorCode: "host_offline",
        errorMessage: `Machine is ${host.status}.`,
        models: [],
        reasoningLevels: [],
        offersReasoningChoice: false,
      };
    }
    try {
      const options = await bb.sdk.providers.models({
        providerId: PROVIDER_ID,
        hostId: host.id,
      });
      const models: ModelInfo[] = options.models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        isDefault: model.isDefault,
        reasoningEfforts: model.supportedReasoningEfforts.map((e) => e.reasoningEffort),
      }));
      const errorCode = resolveHostErrorCode({
        models,
        modelLoadError: options.modelLoadError?.code ?? null,
      });
      const reasoningLevels = collectReasoningLevels(models);
      return {
        hostId: host.id,
        hostName: host.name,
        status: host.status,
        available: errorCode === null,
        errorCode,
        errorMessage: describeLoadError(errorCode),
        models,
        reasoningLevels,
        offersReasoningChoice: offersReasoningChoice(reasoningLevels),
      };
    } catch (error) {
      return {
        hostId: host.id,
        hostName: host.name,
        status: host.status,
        available: false,
        errorCode: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        models: [],
        reasoningLevels: [],
        offersReasoningChoice: false,
      };
    }
  }

  async function readStatus(): Promise<Status> {
    const values = await settings.get();
    const dataDir = await resolveDataDir();
    const entry = findAgent(readConfigFile(dataDir), AGENT_ID) ?? null;
    const hosts = values.manageProvider ? await readHostHealth() : [];

    let warning: string | null = null;
    if (!values.manageProvider) {
      warning = "Provider management is off — BB is not registering acp-kimi.";
    } else if (entry === null) {
      warning = "Not registered yet. Run `bb kimi sync`.";
    } else if (hosts.length > 0 && hosts.every((host) => !host.available)) {
      warning = "Registered, but no connected machine can start the Kimi Code CLI.";
    }

    return {
      managed: values.manageProvider,
      registered: entry !== null,
      providerId: PROVIDER_ID,
      // The CLI, not the wrapper shell — this is what the app and `status`
      // render as "command … acp", and what a user could run themselves.
      command: await resolveRealCommand(),
      displayName: values.displayName.trim() || "Kimi Code",
      configPath: `${dataDir}/config.json`,
      entry: entry as Record<string, unknown> | null,
      hosts,
      warning,
      coalescing: values.manageProvider && values.coalesceProgress,
    };
  }

  // --- rpc ----------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    status: () => readStatus(),
    async sync() {
      const { changed } = await reconcile();
      invalidateHealth();
      return { changed, status: await readStatus() };
    },
    async unregister() {
      return { changed: await unregister() };
    },
    async login(input) {
      const hostId = input.hostId ?? (await resolvePrimaryHostId());
      const hosts = await bb.sdk.hosts.list();
      const host = hosts.find((candidate) => candidate.id === hostId);
      if (host === undefined) throw new Error(`Unknown machine "${hostId}".`);
      const terminal = await bb.sdk.terminals.create({
        scope: { kind: "host_path", hostId, cwd: null },
        cols: 100,
        rows: 30,
        title: "Kimi Code login",
        start: { mode: "command", command: `${await resolveLoginCommand()} login` },
      });
      return { terminalId: terminal.id, hostId, hostName: host.name };
    },
  });

  async function resolveLoginCommand(): Promise<string> {
    // Always the real CLI: `login` is an interactive TTY flow, and routing it
    // through the ACP coalescer would garble it. Shell-quoted because this is
    // the one surface where the path becomes shell SOURCE, not argv data.
    return shellQuote(await resolveRealCommand());
  }

  async function resolvePrimaryHostId(): Promise<string> {
    const config = await bb.sdk.system.config();
    if (config.primaryHostId !== null) return config.primaryHostId;
    const hosts = await bb.sdk.hosts.list();
    const connected = hosts.find((host) => host.status === "connected") ?? hosts[0];
    if (connected === undefined) throw new Error("No BB machines are available.");
    return connected.id;
  }

  // --- cli ----------------------------------------------------------------

  bb.cli.register({
    name: "kimi",
    summary: "Manage the Kimi Code provider (acp-kimi) in BB",
    commands: [
      { name: "status", summary: "Registration and per-machine health", usage: "bb kimi status [--json]" },
      { name: "models", summary: "Models Kimi Code advertises", usage: "bb kimi models [--machine <id-or-name>]" },
      { name: "sync", summary: "Re-register the provider from current settings", usage: "bb kimi sync" },
      { name: "login", summary: "Open a terminal running the Kimi device-code login", usage: "bb kimi login [--machine <id-or-name>]" },
      { name: "skills", summary: "Skill roots Kimi discovers on a machine", usage: "bb kimi skills [--machine <id-or-name>] [--json]" },
      { name: "doctor", summary: "Probe the Kimi ACP handshake on the BB server host", usage: "bb kimi doctor [--json]" },
      { name: "unregister", summary: "Remove the provider from BB's config", usage: "bb kimi unregister" },
    ],
    async run(argv, ctx) {
      // Parse flags first and drop their VALUES from the positional list, so
      // `bb kimi --machine my-mac skills` resolves the subcommand correctly
      // instead of reading "my-mac" as one.
      const VALUE_FLAGS = new Set(["--machine"]);
      const flags = new Map<string, string>();
      let wantsJson = false;
      const positional: string[] = [];
      for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]!;
        if (arg === "--json") {
          wantsJson = true;
        } else if (VALUE_FLAGS.has(arg)) {
          const value = argv[index + 1];
          if (value !== undefined) {
            flags.set(arg.slice(2), value);
            index++;
          }
        } else if (arg.startsWith("--") && arg.includes("=")) {
          const eq = arg.indexOf("=");
          flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        } else if (!arg.startsWith("--")) {
          positional.push(arg);
        }
      }
      const sub = positional[0] ?? "status";
      const flagValue = (name: string): string | undefined => flags.get(name);

      try {
        switch (sub) {
          case "status": {
            const status = await readStatus();
            if (wantsJson) return ok(JSON.stringify(status, null, 2));
            return ok(formatStatus(status));
          }
          case "models": {
            const status = await readStatus();
            const machine = flagValue("machine");
            const hosts =
              machine === undefined
                ? status.hosts
                : status.hosts.filter((h) => h.hostId === machine || h.hostName === machine);
            if (hosts.length === 0) return fail(`No matching machine for "${machine ?? ""}".`);
            return ok(hosts.map(formatHostModels).join("\n\n"));
          }
          case "sync": {
            const { changed } = await reconcile();
            invalidateHealth();
            const status = await readStatus();
            const headline = changed
              ? `Registered ${PROVIDER_ID} (command: ${status.command}).`
              : `${PROVIDER_ID} is already up to date (command: ${status.command}).`;
            return ok(`${headline}\n\n${formatStatus(status)}`);
          }
          case "login": {
            const machine = flagValue("machine");
            const hostId = await resolveMachineArg(machine, ctx.threadId);
            const hosts = await bb.sdk.hosts.list();
            const host = hosts.find((candidate) => candidate.id === hostId);
            const terminal = await bb.sdk.terminals.create({
              scope: { kind: "host_path", hostId, cwd: null },
              cols: 100,
              rows: 30,
              title: "Kimi Code login",
              start: { mode: "command", command: `${await resolveLoginCommand()} login` },
            });
            return ok(
              `Opened a terminal on ${host?.name ?? hostId} running the Kimi device-code login.\n` +
                `Terminal: ${terminal.id}\n` +
                "Complete the flow in that terminal, then run `bb kimi status`.",
            );
          }
          case "doctor": {
            const report = await runDoctor();
            if (wantsJson) return ok(JSON.stringify(report, null, 2));
            return ok(report.text);
          }
          case "skills": {
            const hostId = await resolveMachineArg(flagValue("machine"), ctx.threadId);
            const hosts = await bb.sdk.hosts.list();
            const hostName = hosts.find((h) => h.id === hostId)?.name ?? hostId;
            const report = await readSkills(hostId);
            if (wantsJson) return ok(JSON.stringify({ hostName, ...report }, null, 2));
            if (report.home === null) {
              return fail(`Could not resolve the home directory on ${hostName}.`);
            }
            const lines = [`Skill roots Kimi Code discovers on ${hostName}`, ""];
            if (report.roots.length === 0) {
              lines.push("  none — no discovery root exists on this machine.");
            }
            for (const entry of report.roots) {
              lines.push(
                `  ${entry.root.path}  (${describeRoot(entry.root)}) — ${entry.skills.length} skill${
                  entry.skills.length === 1 ? "" : "s"
                }${entry.truncated ? ", listing truncated" : ""}`,
              );
              for (const line of wrap(entry.skills.join(", "), 72)) lines.push(`      ${line}`);
            }
            if (report.shadowed.length > 0) {
              lines.push("", "Shadowed — these exist but lose their group to a higher priority root:");
              for (const root of report.shadowed) {
                lines.push(`  ${root.path}  (${describeRoot(root)})`);
              }
            }
            lines.push(
              "",
              "Kimi discovers these itself and injects their names and descriptions into",
              "its system prompt, so they work in BB threads. BB's `/` composer menu",
              "cannot list them for any ACP provider — invoke a skill by name instead.",
              "Counts cover real directories; symlinked skills are not followed here, so a",
              "root of symlinks can list fewer than it serves.",
            );
            return ok(lines.join("\n"));
          }
          case "unregister": {
            const changed = await unregister();
            return ok(
              changed
                ? `Removed ${PROVIDER_ID} from BB's config.`
                : `${PROVIDER_ID} was not registered.`,
            );
          }
          default:
            return fail(
              `Unknown subcommand "${sub}". Try: status, models, skills, sync, login, doctor, unregister.`,
            );
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });

  /** Resolve `--machine`, else the invoking thread's host, else the primary host. */
  async function resolveMachineArg(
    machine: string | undefined,
    threadId: string | undefined,
  ): Promise<string> {
    const hosts = await bb.sdk.hosts.list();
    if (machine !== undefined) {
      const match = hosts.find((host) => host.id === machine || host.name === machine);
      if (match === undefined) throw new Error(`Unknown machine "${machine}".`);
      return match.id;
    }
    if (threadId !== undefined) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId !== null) {
          const environment = await bb.sdk.environments.get({
            environmentId: thread.environmentId,
          });
          if (environment.hostId) return environment.hostId;
        }
      } catch {
        // Fall through to the primary host.
      }
    }
    return resolvePrimaryHostId();
  }

  /**
   * What Kimi will actually load on a machine.
   *
   * Runs against the target host through `bb.sdk.files`, never `node:fs` — the
   * CLI handler executes on the BB server, so local filesystem reads would
   * describe the wrong machine.
   */
  async function readSkills(hostId: string): Promise<{
    home: string | null;
    roots: { root: SkillRootCandidate; skills: string[]; truncated: boolean }[];
    shadowed: SkillRootCandidate[];
  }> {
    // `hosts.directory` with no path resolves that machine's home directory.
    let home: string | null = null;
    try {
      home = (await bb.sdk.hosts.directory({ hostId })).directory;
    } catch {
      home = null;
    }
    if (home === null || home.length === 0) return { home: null, roots: [], shadowed: [] };

    const candidates = candidateSkillRoots({ home });
    // One batched existence check beats one listing per candidate root.
    const { existence } = await bb.sdk.hosts.pathsExist({
      hostId,
      paths: candidates.map((candidate) => candidate.path),
    });
    const active = selectActiveRoots(candidates, (path) => existence[path] === true);
    const activePaths = new Set(active.map((candidate) => candidate.path));

    const roots: { root: SkillRootCandidate; skills: string[]; truncated: boolean }[] = [];
    for (const root of active) {
      try {
        const result = await bb.sdk.files.listPaths({
          hostId,
          path: root.path,
          query: "SKILL.md",
          includeFiles: true,
          includeDirectories: false,
          limit: 1000,
        });
        roots.push({
          root,
          skills: skillNamesFromPaths(root.path, result.paths),
          truncated: result.truncated,
        });
      } catch {
        roots.push({ root, skills: [], truncated: false });
      }
    }

    return {
      home,
      roots,
      // Roots that exist but lose their group to a higher-priority sibling.
      shadowed: candidates.filter(
        (candidate) => existence[candidate.path] === true && !activePaths.has(candidate.path),
      ),
    };
  }

  async function runDoctor(): Promise<{ text: string; probe: unknown; status: Status }> {
    const status = await readStatus();
    const desired = await resolveDesiredEntry();
    // Probing the DESIRED entry (wrapper and all) exercises exactly the chain
    // BB spawns, so a coalescer problem shows up here and not just in threads.
    const probe = await probeAcpAgent({
      command: desired.command,
      args: desired.args ?? ["acp"],
      cwd: process.cwd(),
      env: desired.env,
    });

    const lines: string[] = [formatStatus(status), "", "ACP handshake (BB server host only)"];
    if (!probe.ok) {
      lines.push(`  result       failed (${probe.code ?? "unknown"})`);
      lines.push(`  error        ${probe.error ?? "unknown error"}`);
      if (probe.code === "missing_executable") {
        lines.push("  fix          Install Kimi Code, or set the CLI path setting to an absolute path.");
      } else if (probe.error === "timed out" || probe.code === "timeout") {
        lines.push(
          "  fix          The first run after a CLI upgrade does one-time setup and can be slow.",
        );
        lines.push("               Run `bb kimi doctor` again before treating this as a failure.");
      } else {
        lines.push("  fix          Run `bb kimi login` if this is an authentication failure.");
      }
    } else {
      const model = findModelOption(probe.configOptions);
      const thinking = findThinkingOption(probe.configOptions);
      lines.push(`  agent        ${probe.agentName ?? "unknown"} ${probe.agentVersion ?? ""}`.trimEnd());
      lines.push(`  protocol     v${probe.protocolVersion ?? "?"}`);
      lines.push(
        `  auth         ${probe.authMethods.map((m) => m.id).join(", ") || "none advertised"}`,
      );
      const modelValues = (model?.options ?? []).map((option) => option.value);
      const thinkingValues = (thinking?.options ?? []).map((option) => option.value);
      lines.push(
        `  models       ${modelValues.length > 0 ? `${modelValues.length} — ${modelValues.join(", ")}` : "not advertised"}`,
      );
      lines.push(
        `  thinking     ${
          thinking ? `${thinking.id} → ${thinkingValues.join(", ")}` : "not advertised"
        }`,
      );

      // Both of these are advertised by the CLI, so an outdated or
      // stale-provisioned install silently shows less than the account offers.
      const notes: string[] = [];
      const versionGap = describeVersionGap(probe.agentVersion);
      if (versionGap !== null) notes.push(versionGap);
      if (!exposesReasoningLevels({ values: thinkingValues })) {
        notes.push(
          "This CLI advertises no selectable reasoning levels, so BB's reasoning picker " +
            "has nothing to offer and Kimi runs at the effort in ~/.kimi-code/config.toml.",
        );
      }
      notes.push(
        "The model list is provisioned by the Kimi account at login (`source=oauth`), not " +
          "by this plugin. If BB shows fewer models than your plan offers, run `bb kimi login` " +
          "to re-provision it.",
      );
      for (const note of notes) {
        lines.push("");
        for (const line of wrap(note, 76)) lines.push(`  ${line}`);
      }
    }
    return { text: lines.join("\n"), probe, status };
  }

  // --- lifecycle ----------------------------------------------------------

  // Reconciliation lives in a service rather than the factory so the plugin
  // loads cleanly in harnesses where bb.sdk is not yet bound, and so a missing
  // CLI reports as needs-configuration instead of a load error.
  bb.background.service("provider-sync", {
    async start(signal) {
      try {
        await reconcile();
      } catch (error) {
        bb.log.error(
          `provider registration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }

      while (!signal.aborted) {
        try {
          // Re-run distribution each cycle, not just at load. Machines are
          // enrolled and reconnected at arbitrary times, and a host that was
          // offline (or that carries a wrapper from an older plugin version)
          // would otherwise run the plain CLI forever while status reports
          // coalescing as on. The content check upstream makes the steady
          // state one read per host per cycle.
          const values = await settings.get();
          if (values.manageProvider && values.coalesceProgress) {
            await distributeWrapperOnce();
          }
        } catch (error) {
          bb.log.warn(
            `coalescer distribution sweep failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        try {
          const hosts = await readHostHealth();
          const reachable = hosts.filter((host) => host.status === "connected");
          if (reachable.length > 0 && reachable.every((host) => !host.available)) {
            const codes = new Set(reachable.map((host) => host.errorCode));
            if (codes.has("auth_required")) {
              bb.status.needsConfiguration(
                "Kimi Code is not signed in. Run `bb kimi login`, then reload this plugin.",
              );
            } else {
              bb.status.needsConfiguration(
                "No connected machine could start the Kimi Code CLI. Install it " +
                  "(https://moonshotai.github.io/kimi-code/) or set an absolute CLI path, " +
                  "then run `bb kimi doctor`.",
              );
            }
          }
        } catch (error) {
          bb.log.warn(
            `health check failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await sleep(HEALTH_INTERVAL_MS, signal);
      }
    },
  });

  settings.onChange(() => {
    invalidateHealth();
    void reconcile().catch((error: unknown) => {
      bb.log.error(
        `re-registration after settings change failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  });

  // Deliberately NOT removing the config entry on dispose: dispose also runs on
  // every plugin reload, and pulling the provider out from under a running Kimi
  // thread would break it. `bb kimi unregister` is the explicit removal path.
  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}

// --- formatting -------------------------------------------------------------

function formatStatus(status: Status): string {
  const lines = [
    "Kimi Code provider",
    `  provider     ${status.providerId}`,
    `  registered   ${status.registered ? "yes" : "no"}`,
    `  managed      ${status.managed ? "yes" : "no (settings)"}`,
    `  command      ${status.command} acp`,
    `  coalescing   ${status.coalescing ? "on — tool-call progress is throttled via the wrapper" : "off"}`,
    `  display name ${status.displayName}`,
    `  config       ${status.configPath}`,
  ];
  if (status.hosts.length > 0) {
    lines.push("", "Machines");
    for (const host of status.hosts) {
      if (!host.available) {
        lines.push(`  ${host.hostName.padEnd(22)} ${host.errorMessage ?? "unavailable"}`);
        continue;
      }
      const reasoning = host.offersReasoningChoice
        ? host.reasoningLevels.join("/")
        : "none advertised";
      lines.push(
        `  ${host.hostName.padEnd(22)} ok — ${host.models.length} model${
          host.models.length === 1 ? "" : "s"
        }, reasoning: ${reasoning}`,
      );
    }
  }

  const stale = status.hosts.filter((host) => host.available && !host.offersReasoningChoice);
  if (stale.length > 0) {
    lines.push(
      "",
      `! ${stale.map((h) => h.hostName).join(", ")}: no selectable reasoning levels.`,
      "  That machine's Kimi Code CLI is likely outdated — upgrade it with",
      "  `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`.",
    );
  }
  if (status.warning !== null) lines.push("", `! ${status.warning}`);
  return lines.join("\n");
}

function formatHostModels(host: HostHealth): string {
  if (!host.available) {
    return `${host.hostName}: ${host.errorMessage ?? "unavailable"}`;
  }
  const rows = host.models.map((model) => {
    // A lone effort is BB's placeholder for "the agent manages this", not a choice.
    const efforts = model.reasoningEfforts.length > 1 ? model.reasoningEfforts.join("/") : "—";
    return `  ${model.isDefault ? "*" : " "} ${model.id.padEnd(38)} ${model.displayName.padEnd(24)} ${efforts}`;
  });
  const header = `${host.hostName}:`;
  const columns = `  ${" ".padEnd(1)} ${"model".padEnd(38)} ${"name".padEnd(24)} reasoning`;
  return [header, columns, ...rows].join("\n");
}

function ok(stdout: string) {
  return { exitCode: 0, stdout: `${stdout}\n` };
}

function fail(stderr: string) {
  return { exitCode: 1, stderr: `${stderr}\n` };
}

/** Greedy word wrap, so long diagnostic notes stay readable in a terminal. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/u)) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
