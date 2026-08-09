// Interpreting what BB reports about a host's Kimi Code install.
//
// The subtle part: BB does NOT set `modelLoadError` for custom ACP agents whose
// binary is missing or whose handshake fails. It silently substitutes a single
// synthetic `acp-default` model. So "no error and a non-empty list" is not
// sufficient evidence that the agent is healthy — a catalog containing only
// `acp-default` means BB never got a real answer.

/** BB's placeholder model id for an ACP agent whose catalog it could not read. */
export const ACP_DEFAULT_MODEL_ID = "acp-default";

export type HostErrorCode =
  | "missing_executable"
  | "auth_required"
  | "timeout"
  | "failed"
  | "unresolved_catalog"
  | "host_offline"
  | "transient";

/**
 * Whether a providers.models failure is a passing condition of the DAEMON
 * (busy, restarting, disconnecting) rather than a statement about the Kimi
 * install. These must not flip the plugin into needs-configuration: the
 * observed failure mode was a `command_timeout` during a restart marking Kimi
 * unavailable and alarming the user while threads were actually fine.
 */
export function isTransientProviderError(message: string): boolean {
  return /timed out|shutting down|not connected|temporarily unavailable|disconnected/i.test(
    message,
  );
}

/**
 * Resolve a host's error code, or null when Kimi is genuinely healthy there.
 * `modelLoadError` wins when BB does report one; otherwise an unresolved
 * catalog is the fallback signal.
 */
export function resolveHostErrorCode(args: {
  models: { id: string }[];
  modelLoadError: string | null;
}): HostErrorCode | null {
  if (args.modelLoadError !== null) return args.modelLoadError as HostErrorCode;
  const resolved = args.models.some((model) => model.id !== ACP_DEFAULT_MODEL_ID);
  return resolved ? null : "unresolved_catalog";
}

/** BB's reasoning ladder, in the order BB presents it. */
const EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
];

/**
 * The reasoning levels a host's CLI actually offers, unioned across its models
 * and sorted into BB's order.
 *
 * BB substitutes a single placeholder effort for an agent that advertises no
 * usable `thought_level` values, so a one-entry union means "no real choice"
 * rather than "one level". That is the per-host signal for an outdated CLI —
 * and it needs no extra process spawn, because BB already resolved it through
 * that host's own daemon.
 */
export function collectReasoningLevels(
  models: { reasoningEfforts: string[] }[],
): string[] {
  const seen = new Set<string>();
  for (const model of models) {
    // A model with a single effort is reporting BB's placeholder, not a choice.
    // Unioning it in would invent a level the user cannot select — e.g. a
    // "medium" placeholder appearing alongside a real low/high/max ladder.
    if (model.reasoningEfforts.length < 2) continue;
    for (const effort of model.reasoningEfforts) seen.add(effort);
  }
  return [...seen].sort((a, b) => {
    const ai = EFFORT_ORDER.indexOf(a);
    const bi = EFFORT_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

/** Whether those levels represent a real choice the user can make in BB. */
export function offersReasoningChoice(levels: string[]): boolean {
  return levels.length > 1;
}

export function describeLoadError(code: string | null): string | null {
  switch (code) {
    case null:
      return null;
    case "missing_executable":
      return "The Kimi Code CLI was not found on this machine's PATH.";
    case "auth_required":
      return "Kimi Code is installed but not signed in. Run `bb kimi login`.";
    case "timeout":
      return "Kimi Code did not respond in time.";
    case "host_offline":
      return "Machine is not connected.";
    case "transient":
      return "Temporarily unreachable (daemon busy or restarting) — retrying.";
    case "unresolved_catalog":
      return (
        "BB could not read Kimi's model list — the CLI is missing, not signed in, " +
        "or failed to start. Run `bb kimi doctor`."
      );
    default:
      return "Kimi Code failed to report its models.";
  }
}
