import { describe, expect, it } from "vitest";

import {
  groupByWorkDir,
  parseSessionIndex,
  summarizeRestorability,
} from "./sessions";

const entry = (sessionId: string, workDir: string) =>
  JSON.stringify({ sessionId, sessionDir: `/sessions/${sessionId}`, workDir });

describe("parseSessionIndex", () => {
  it("parses well-formed JSONL entries", () => {
    const raw = [entry("s1", "/w/a"), entry("s2", "/w/b")].join("\n");
    expect(parseSessionIndex(raw)).toEqual([
      { sessionId: "s1", sessionDir: "/sessions/s1", workDir: "/w/a" },
      { sessionId: "s2", sessionDir: "/sessions/s2", workDir: "/w/b" },
    ]);
  });

  it("skips malformed, foreign-shaped, and blank lines instead of failing", () => {
    const raw = [
      "",
      "not json {",
      JSON.stringify({ sessionId: 42, sessionDir: "/x", workDir: "/y" }),
      JSON.stringify(["array"]),
      "null",
      entry("good", "/w/a"),
      "   ",
    ].join("\n");
    expect(parseSessionIndex(raw)).toEqual([
      { sessionId: "good", sessionDir: "/sessions/good", workDir: "/w/a" },
    ]);
  });

  it("returns empty for an empty or whitespace-only file", () => {
    expect(parseSessionIndex("")).toEqual([]);
    expect(parseSessionIndex("\n\n  \n")).toEqual([]);
  });

  it("tolerates a trailing partial line (file read mid-append)", () => {
    const raw = `${entry("s1", "/w/a")}\n{"sessionId":"s2","sess`;
    expect(parseSessionIndex(raw)).toHaveLength(1);
  });
});

describe("groupByWorkDir", () => {
  it("groups sessions under their recorded root, preserving first-seen order", () => {
    const groups = groupByWorkDir([
      { sessionId: "s1", sessionDir: "/d1", workDir: "/w/a" },
      { sessionId: "s2", sessionDir: "/d2", workDir: "/w/b" },
      { sessionId: "s3", sessionDir: "/d3", workDir: "/w/a" },
    ]);
    expect(groups).toEqual([
      { workDir: "/w/a", sessionIds: ["s1", "s3"] },
      { workDir: "/w/b", sessionIds: ["s2"] },
    ]);
  });

  it("handles the empty input", () => {
    expect(groupByWorkDir([])).toEqual([]);
  });
});

describe("summarizeRestorability", () => {
  const groups = [
    { workDir: "/w/alive", sessionIds: ["s1", "s2"] },
    { workDir: "/w/gone", sessionIds: ["s3"] },
    { workDir: "/w/also-gone", sessionIds: ["s4", "s5", "s6"] },
  ];

  it("splits groups by workspace-root existence and counts sessions", () => {
    const summary = summarizeRestorability(groups, (path) => path === "/w/alive");
    expect(summary.totalSessions).toBe(6);
    expect(summary.totalWorkDirs).toBe(3);
    expect(summary.restorable.map((g) => g.workDir)).toEqual(["/w/alive"]);
    expect(summary.broken.map((g) => g.workDir)).toEqual(["/w/gone", "/w/also-gone"]);
  });

  it("treats an unverifiable root as broken — it will fail Kimi's check the same way", () => {
    const summary = summarizeRestorability(groups, () => false);
    expect(summary.restorable).toEqual([]);
    expect(summary.broken).toHaveLength(3);
  });

  it("summarizes the empty store", () => {
    const summary = summarizeRestorability([], () => true);
    expect(summary.totalSessions).toBe(0);
    expect(summary.totalWorkDirs).toBe(0);
    expect(summary.restorable).toEqual([]);
    expect(summary.broken).toEqual([]);
  });
});
