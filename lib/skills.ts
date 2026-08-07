// Where Kimi Code discovers skills.
//
// BB's own `/` composer menu cannot list skills for an ACP provider: BB's skill
// model attributes every skill to `claude-code` or `codex` (its skill provider
// enum is literally those two), and the ACP launch spec carries no `skillRoots`
// field. That is a BB-side limit shared by every ACP provider.
//
// It does not stop skills working. Kimi Code does its own discovery at session
// start and injects each skill's name, path, and description into its system
// prompt, so skills load in a BB thread exactly as they do in the terminal —
// verified by having a BB Kimi thread read a skill's frontmatter back.
//
// These roots are the documented ones:
// https://moonshotai.github.io/kimi-cli/en/customization/skills.html
//
// The subtlety worth encoding: within a scope, the "brand" group and the
// "generic" group are each MUTUALLY EXCLUSIVE — the first root that exists
// wins and the rest are skipped. So creating `~/.kimi/skills` silently hides
// `~/.claude/skills`, which is exactly the kind of surprise this command exists
// to make visible.

export type SkillScope = "project" | "user";
export type SkillGroup = "brand" | "generic";

export interface SkillRootCandidate {
  scope: SkillScope;
  group: SkillGroup;
  /** Absolute path, or project-relative when `cwd` was not supplied. */
  path: string;
}

function joinPath(base: string, rest: string): string {
  return `${base.replace(/\/+$/u, "")}/${rest}`;
}

/**
 * Every root Kimi may consider, in documented priority order. Project scope
 * outranks user scope; within a scope the brand group is consulted before the
 * generic group.
 */
export function candidateSkillRoots(args: {
  home: string;
  cwd?: string | null;
}): SkillRootCandidate[] {
  const candidates: SkillRootCandidate[] = [];
  const cwd = args.cwd ?? null;
  if (cwd !== null) {
    for (const rest of [".kimi/skills", ".claude/skills", ".codex/skills"]) {
      candidates.push({ scope: "project", group: "brand", path: joinPath(cwd, rest) });
    }
    candidates.push({ scope: "project", group: "generic", path: joinPath(cwd, ".agents/skills") });
  }
  for (const rest of [".kimi/skills", ".claude/skills", ".codex/skills"]) {
    candidates.push({ scope: "user", group: "brand", path: joinPath(args.home, rest) });
  }
  candidates.push({ scope: "user", group: "generic", path: joinPath(args.home, ".config/agents/skills") });
  candidates.push({ scope: "user", group: "generic", path: joinPath(args.home, ".agents/skills") });
  return candidates;
}

/**
 * Apply the mutual-exclusion rule: at most one root per (scope, group), the
 * highest-priority one that exists.
 */
export function selectActiveRoots(
  candidates: SkillRootCandidate[],
  exists: (path: string) => boolean,
): SkillRootCandidate[] {
  const taken = new Set<string>();
  const active: SkillRootCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.scope}/${candidate.group}`;
    if (taken.has(key)) continue;
    if (!exists(candidate.path)) continue;
    taken.add(key);
    active.push(candidate);
  }
  return active;
}

/**
 * Skill folder names from a recursive path listing of a root, derived from the
 * `SKILL.md` files it contains. Kimi also accepts a bare `<name>.md` directly
 * in a root; those are included too.
 */
export function skillNamesFromPaths(
  root: string,
  paths: { kind: string; path: string; name: string }[],
): string[] {
  const prefix = `${root.replace(/\/+$/u, "")}/`;
  const names = new Set<string>();
  for (const entry of paths) {
    if (entry.kind !== "file") continue;
    const absolute = entry.path.startsWith("/") ? entry.path : `${prefix}${entry.path}`;
    if (!absolute.startsWith(prefix)) continue;
    const relative = absolute.slice(prefix.length);
    const segments = relative.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 2 && segments[1] === "SKILL.md") {
      names.add(segments[0]!);
    } else if (segments.length === 1 && segments[0]!.endsWith(".md") && segments[0] !== "SKILL.md") {
      names.add(segments[0]!.slice(0, -3));
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function describeRoot(candidate: SkillRootCandidate): string {
  return `${candidate.scope} · ${candidate.group}`;
}
