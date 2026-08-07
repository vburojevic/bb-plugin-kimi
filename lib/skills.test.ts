import { describe, expect, it } from "vitest";

import { candidateSkillRoots, selectActiveRoots, skillNamesFromPaths } from "./skills";

const HOME = "/Users/me";

describe("candidateSkillRoots", () => {
  it("lists user roots in documented priority order", () => {
    expect(candidateSkillRoots({ home: HOME }).map((c) => c.path)).toEqual([
      "/Users/me/.kimi/skills",
      "/Users/me/.claude/skills",
      "/Users/me/.codex/skills",
      "/Users/me/.config/agents/skills",
      "/Users/me/.agents/skills",
    ]);
  });

  it("puts project roots ahead of user roots", () => {
    const roots = candidateSkillRoots({ home: HOME, cwd: "/work/app" });
    expect(roots[0]).toEqual({ scope: "project", group: "brand", path: "/work/app/.kimi/skills" });
    expect(roots.filter((r) => r.scope === "project").map((r) => r.path)).toEqual([
      "/work/app/.kimi/skills",
      "/work/app/.claude/skills",
      "/work/app/.codex/skills",
      "/work/app/.agents/skills",
    ]);
  });

  it("tolerates a trailing slash on cwd and home", () => {
    const roots = candidateSkillRoots({ home: "/Users/me/", cwd: "/work/app/" });
    expect(roots).toContainEqual({
      scope: "project",
      group: "brand",
      path: "/work/app/.kimi/skills",
    });
    expect(roots).toContainEqual({
      scope: "user",
      group: "generic",
      path: "/Users/me/.agents/skills",
    });
  });
});

describe("selectActiveRoots", () => {
  it("takes only the first existing root per group", () => {
    // The measured real-world case: ~/.claude/skills wins the brand group and
    // ~/.agents/skills wins the generic group, so both are active.
    const present = new Set(["/Users/me/.claude/skills", "/Users/me/.agents/skills"]);
    const active = selectActiveRoots(candidateSkillRoots({ home: HOME }), (p) => present.has(p));
    expect(active.map((r) => r.path)).toEqual([
      "/Users/me/.claude/skills",
      "/Users/me/.agents/skills",
    ]);
  });

  it("shadows a lower-priority brand root — the surprising case", () => {
    // Creating ~/.kimi/skills silently hides ~/.claude/skills.
    const present = new Set(["/Users/me/.kimi/skills", "/Users/me/.claude/skills"]);
    const active = selectActiveRoots(candidateSkillRoots({ home: HOME }), (p) => present.has(p));
    expect(active.map((r) => r.path)).toEqual(["/Users/me/.kimi/skills"]);
  });

  it("prefers ~/.config/agents/skills over ~/.agents/skills", () => {
    const present = new Set(["/Users/me/.config/agents/skills", "/Users/me/.agents/skills"]);
    const active = selectActiveRoots(candidateSkillRoots({ home: HOME }), (p) => present.has(p));
    expect(active.map((r) => r.path)).toEqual(["/Users/me/.config/agents/skills"]);
  });

  it("keeps project and user scopes independent", () => {
    const present = new Set(["/work/app/.agents/skills", "/Users/me/.claude/skills"]);
    const active = selectActiveRoots(
      candidateSkillRoots({ home: HOME, cwd: "/work/app" }),
      (p) => present.has(p),
    );
    expect(active.map((r) => r.path)).toEqual([
      "/work/app/.agents/skills",
      "/Users/me/.claude/skills",
    ]);
  });

  it("returns nothing when no root exists", () => {
    expect(selectActiveRoots(candidateSkillRoots({ home: HOME }), () => false)).toEqual([]);
  });
});

describe("skillNamesFromPaths", () => {
  const root = "/Users/me/.agents/skills";

  it("derives folder names from SKILL.md files", () => {
    const names = skillNamesFromPaths(root, [
      { kind: "file", path: `${root}/shadcn/SKILL.md`, name: "SKILL.md" },
      { kind: "file", path: `${root}/apple-hig/SKILL.md`, name: "SKILL.md" },
    ]);
    expect(names).toEqual(["apple-hig", "shadcn"]);
  });

  it("accepts relative paths from the listing API", () => {
    const names = skillNamesFromPaths(root, [
      { kind: "file", path: "shadcn/SKILL.md", name: "SKILL.md" },
    ]);
    expect(names).toEqual(["shadcn"]);
  });

  it("ignores nested support files, so a skill is not double-counted", () => {
    const names = skillNamesFromPaths(root, [
      { kind: "file", path: `${root}/shadcn/SKILL.md`, name: "SKILL.md" },
      { kind: "file", path: `${root}/shadcn/rules/a.md`, name: "a.md" },
      { kind: "file", path: `${root}/shadcn/references/deep/b.md`, name: "b.md" },
      { kind: "directory", path: `${root}/shadcn`, name: "shadcn" },
    ]);
    expect(names).toEqual(["shadcn"]);
  });

  it("recognises a bare <name>.md placed directly in a root", () => {
    const names = skillNamesFromPaths(root, [
      { kind: "file", path: `${root}/quick-note.md`, name: "quick-note.md" },
    ]);
    expect(names).toEqual(["quick-note"]);
  });

  it("ignores paths outside the root", () => {
    const names = skillNamesFromPaths(root, [
      { kind: "file", path: "/somewhere/else/x/SKILL.md", name: "SKILL.md" },
    ]);
    expect(names).toEqual([]);
  });
});
