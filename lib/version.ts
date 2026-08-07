// Kimi Code CLI version gating.
//
// BB renders exactly what the ACP agent advertises on `session/new`, so an
// outdated CLI silently under-reports. Measured on two machines:
//
//   0.28.1 → 3 models, thinking: ["on"]              (BB shows no reasoning levels)
//   0.31.1 → 4 models, thinking: ["low","high","max"] (BB shows Low/High/Max)
//
// The exact release that added per-effort thinking is somewhere in
// (0.28.1, 0.31.1]; 0.31.1 is the lowest version verified to work, so that is
// the threshold used here rather than a guessed boundary.

export const MIN_VERIFIED_VERSION = "0.31.1";

/** Numeric-segment compare. Returns <0, 0, or >0. Non-numeric suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/u, "")
      .split(/[.+-]/u)
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part));
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface ThinkingCapability {
  /** Values the agent advertises for its thought_level config option. */
  values: string[];
}

/** BB's reasoning ladder. Anything outside it cannot be selected in BB. */
const BB_SELECTABLE = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
]);

/** Whether BB can offer a real reasoning choice from these thought_level values. */
export function exposesReasoningLevels(capability: ThinkingCapability): boolean {
  return capability.values.filter((value) => BB_SELECTABLE.has(value)).length > 1;
}

/**
 * A warning when the CLI is older than the lowest version verified to advertise
 * its full model list and per-effort thinking, or null when it is new enough.
 */
export function describeVersionGap(version: string | null): string | null {
  if (version === null) return null;
  if (compareVersions(version, MIN_VERIFIED_VERSION) >= 0) return null;
  return (
    `Kimi Code ${version} is older than ${MIN_VERIFIED_VERSION}, the lowest version verified ` +
    "to advertise its full model list and per-effort thinking (low/high/max) over ACP. " +
    "Older builds report a single \"on\" thinking value, so BB's reasoning picker has " +
    "nothing to select, and they list fewer models. Upgrade with " +
    "`curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`."
  );
}
