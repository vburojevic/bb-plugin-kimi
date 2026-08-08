// Pure read/merge/write logic for BB's data-dir `config.json`.
//
// That file is shared: alongside `customAcpAgents` it can hold `machineCredential`,
// `connectMachineId`, `serverUrl`, `config`, and `customModels`. Every mutation here
// is a merge that preserves unknown keys, and malformed JSON throws rather than
// being silently replaced with a fresh object.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LAUNCH_SNIPPET } from "./wrapper";

export const CONFIG_FILE_NAME = "config.json";

/** Matches BB's `customAcpAgentSchema` (strict — no extra keys survive validation). */
export interface CustomAcpAgentEntry {
  id: string;
  displayName: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  logo?: string;
}

export type BbConfig = Record<string, unknown>;

export function configPath(dataDir: string): string {
  return join(dataDir, CONFIG_FILE_NAME);
}

/**
 * Parse config.json. A missing file is an empty config; malformed JSON throws so
 * callers refuse to overwrite a file they could not understand.
 */
export function parseConfig(raw: string | null): BbConfig {
  if (raw === null || raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `config.json is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        "Refusing to overwrite it — fix or delete the file and sync again.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.json must contain a JSON object. Refusing to overwrite it.");
  }
  return parsed as BbConfig;
}

export function readConfigFile(dataDir: string): BbConfig {
  let raw: string | null;
  try {
    raw = readFileSync(configPath(dataDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return parseConfig(raw);
}

/** Existing entries, tolerating a malformed/absent `customAcpAgents` value. */
export function listAgents(config: BbConfig): CustomAcpAgentEntry[] {
  const value = config.customAcpAgents;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is CustomAcpAgentEntry =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
}

export function findAgent(config: BbConfig, id: string): CustomAcpAgentEntry | undefined {
  return listAgents(config).find((entry) => entry.id === id);
}

/** Key-order-insensitive structural comparison, so a reorder is not a "change". */
export function entriesEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export interface MergeResult {
  config: BbConfig;
  changed: boolean;
}

/**
 * Insert or replace one agent entry, preserving every sibling entry and every
 * unrelated top-level key. Position is preserved on replace.
 */
export function upsertAgent(config: BbConfig, entry: CustomAcpAgentEntry): MergeResult {
  const agents = listAgents(config);
  const index = agents.findIndex((candidate) => candidate.id === entry.id);
  if (index >= 0 && entriesEqual(agents[index], entry)) {
    return { config, changed: false };
  }
  const next = index >= 0 ? agents.map((c, i) => (i === index ? entry : c)) : [...agents, entry];
  return { config: { ...config, customAcpAgents: next }, changed: true };
}

/** Drop one agent entry. Removes the `customAcpAgents` key entirely when it empties. */
export function removeAgent(config: BbConfig, id: string): MergeResult {
  const agents = listAgents(config);
  if (!agents.some((entry) => entry.id === id)) return { config, changed: false };
  const next = agents.filter((entry) => entry.id !== id);
  const merged: BbConfig = { ...config };
  if (next.length === 0) delete merged.customAcpAgents;
  else merged.customAcpAgents = next;
  return { config: merged, changed: true };
}

/**
 * Write via temp-file + rename so a crash mid-write cannot truncate a config
 * holding the machine credential.
 */
export function writeConfigFile(dataDir: string, config: BbConfig): void {
  const target = configPath(dataDir);
  const temp = `${target}.plugin-kimi.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
}

export interface DesiredEntryArgs {
  id: string;
  displayName: string;
  command: string;
  logo?: string | undefined;
  /** Route the agent through the tool-call-progress coalescer (see wrapper.ts). */
  coalesce?: boolean | undefined;
}

/**
 * The canonical acp-kimi entry.
 *
 * Deliberately omits `modelCli`, `reasoningCli`, `nativeReasoning`, and
 * `permissionCli`. Kimi Code's ACP server advertises its models as a `model`
 * config option (BB reads those natively) and its thinking control as a
 * `thought_level` option, and BB's ACP bridge enforces permission modes itself
 * via `session/request_permission`. Declaring CLI-flag variants of any of these
 * would pass flags `kimi acp` does not accept.
 *
 * With `coalesce`, the command becomes `/bin/sh -c <LAUNCH_SNIPPET>` and the
 * real CLI travels in `env.KIMI_ACP_REAL`: the snippet resolves per host at
 * spawn time, running the coalescer where it has been materialized and exec'ing
 * the plain CLI everywhere else, so the single shared entry never breaks a
 * host the wrapper has not reached.
 */
export function buildDesiredEntry(args: DesiredEntryArgs): CustomAcpAgentEntry {
  const identity = {
    id: args.id,
    displayName: args.displayName,
    ...(args.logo === undefined ? {} : { logo: args.logo }),
  };
  if (args.coalesce === true) {
    return {
      ...identity,
      command: "/bin/sh",
      args: ["-c", LAUNCH_SNIPPET, "kimi-acp", "acp"],
      env: { KIMI_ACP_REAL: args.command },
    };
  }
  return { ...identity, command: args.command, args: ["acp"] };
}
