// Pure analysis of Kimi Code's session store (`~/.kimi-code/session_index.jsonl`).
//
// Why this exists: Kimi's `session/load` validates the workspace root RECORDED
// AT SESSION CREATION, not the cwd passed on resume. BB destroys and
// re-provisions worktree environments as a matter of course, so any thread
// whose original directory is gone cannot restore — BB's bridge falls back to
// a fresh session and the agent silently loses all previous messages. The
// coalescer wrapper heals this at load time (see wrapper.ts); `bb kimi
// sessions` uses this module to make the same condition visible up front.

export interface SessionIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

/**
 * Parse the JSONL session index. Malformed or foreign-shaped lines are
 * skipped, not fatal — the index is another program's private file and this
 * is a diagnostic, so partial insight beats an error.
 */
export function parseSessionIndex(raw: string): SessionIndexEntry[] {
  const entries: SessionIndexEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.sessionId !== "string" ||
      typeof record.sessionDir !== "string" ||
      typeof record.workDir !== "string"
    ) {
      continue;
    }
    entries.push({
      sessionId: record.sessionId,
      sessionDir: record.sessionDir,
      workDir: record.workDir,
    });
  }
  return entries;
}

export interface WorkDirGroup {
  workDir: string;
  sessionIds: string[];
}

/** Group sessions by their recorded workspace root, preserving first-seen order. */
export function groupByWorkDir(entries: SessionIndexEntry[]): WorkDirGroup[] {
  const groups = new Map<string, WorkDirGroup>();
  for (const entry of entries) {
    let group = groups.get(entry.workDir);
    if (group === undefined) {
      group = { workDir: entry.workDir, sessionIds: [] };
      groups.set(entry.workDir, group);
    }
    group.sessionIds.push(entry.sessionId);
  }
  return [...groups.values()];
}

export interface RestorabilitySummary {
  totalSessions: number;
  totalWorkDirs: number;
  /** Groups whose workspace root exists — these sessions can restore. */
  restorable: WorkDirGroup[];
  /** Groups whose workspace root is gone — restore fails until healed. */
  broken: WorkDirGroup[];
}

/**
 * Split groups by whether their workspace root still exists.
 * `exists` answers for a workDir path; unknown paths count as broken, because
 * an unverifiable root will fail Kimi's check exactly like a missing one.
 */
export function summarizeRestorability(
  groups: WorkDirGroup[],
  exists: (path: string) => boolean,
): RestorabilitySummary {
  const restorable: WorkDirGroup[] = [];
  const broken: WorkDirGroup[] = [];
  for (const group of groups) {
    (exists(group.workDir) ? restorable : broken).push(group);
  }
  return {
    totalSessions: groups.reduce((sum, group) => sum + group.sessionIds.length, 0),
    totalWorkDirs: groups.length,
    restorable,
    broken,
  };
}
