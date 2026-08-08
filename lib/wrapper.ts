// The tool-call-progress coalescer that sits between BB and `kimi acp`.
//
// Why it exists: BB's ACP bridge persists EVERY `session/update` notification
// as a row in its event store. Kimi Code streams a `tool_call_update` snapshot
// for each terminal-output tick, so one long command execution can write tens
// of thousands of ~4KB rows — a single day-long thread once grew bb.db past
// half a gigabyte and pinned the server's main thread in synchronous SQLite
// scans. The agent cannot be told to stream less, and the bridge is BB core,
// so the one seam this plugin owns is the spawned process itself: register a
// wrapper instead of the bare CLI and thin the firehose in transit.
//
// Losslessness: ACP `tool_call_update` fields REPLACE the tool call's previous
// values (they are partial snapshots, not deltas), so merging a run of updates
// per (sessionId, toolCallId) — newer fields over older — and emitting the
// merged snapshot is semantically identical to delivering every tick. Terminal
// statuses flush immediately, and any non-coalescable message flushes all held
// state first, so relative ordering BB can observe is preserved.
//
// Robustness posture: the agent side of the pipe is treated as untrusted
// input. Decoding goes through a StringDecoder so multi-byte UTF-8 split
// across pipe chunks can never corrupt a payload; the line buffer is capped
// (KIMI_MAX_LINE_BYTES, default 32MB) and overflows degrade to byte-faithful
// passthrough instead of unbounded growth; stdout honors backpressure by
// pausing the agent rather than buffering without limit; and merged objects
// are built with spread (define semantics), which keeps a hostile `__proto__`
// key inert data rather than prototype pollution.
//
// The wrapper is a standalone Node script because it must run where the agent
// runs — any enrolled machine, without this plugin's code or node_modules. It
// is embedded here as a string (same pattern as the logo) and materialized to
// `$HOME/.bb/plugins/kimi/acp-coalesce.mjs` on every connected host.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const WRAPPER_FILE_NAME = "acp-coalesce.mjs";

/** Where the launch snippet expects the wrapper, relative to each host's $HOME. */
export const WRAPPER_HOME_RELATIVE_PATH = `.bb/plugins/kimi/${WRAPPER_FILE_NAME}`;

/**
 * The `/bin/sh -c` body registered as the agent command.
 *
 * `/bin/sh` exists at the same path on every machine BB can enroll, which is
 * what makes ONE shared config.json entry safe across hosts: each host checks
 * for its own materialized wrapper (and a `node` on the daemon's PATH) at
 * spawn time and otherwise execs the plain CLI — a host the plugin has not
 * reached yet degrades to exactly today's behavior instead of breaking.
 * Positional args (`"$@"`) pass through either branch untouched, and the real
 * CLI path only ever travels as quoted DATA (`$KIMI_ACP_REAL`), never as
 * shell source.
 */
export const LAUNCH_SNIPPET =
  `W="$HOME/${WRAPPER_HOME_RELATIVE_PATH}"; ` +
  'if [ -f "$W" ] && command -v node >/dev/null 2>&1; then exec node "$W" "$@"; fi; ' +
  'exec "${KIMI_ACP_REAL:-kimi}" "$@"';

export const WRAPPER_SOURCE = `#!/usr/bin/env node
// ACP stdio proxy: coalesces tool_call_update notifications from the agent
// so BB persists snapshots at most every KIMI_COALESCE_MS (default 500ms) per
// tool call, instead of one event per output tick. Managed by bb-plugin-kimi —
// edits are overwritten on the next provider sync.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const THROTTLE_MS = (() => {
  const parsed = Number(process.env.KIMI_COALESCE_MS ?? "500");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
})();
// Longest line held for reassembly; anything longer streams through verbatim.
const MAX_LINE_BYTES = (() => {
  const parsed = Number(process.env.KIMI_MAX_LINE_BYTES ?? String(32 * 1024 * 1024));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32 * 1024 * 1024;
})();
const REAL = process.env.KIMI_ACP_REAL ?? "kimi";

const child = spawn(REAL, process.argv.slice(2), {
  stdio: ["pipe", "pipe", "inherit"],
});
child.on("error", (error) => {
  process.stderr.write(\`acp-coalesce: could not start \${REAL}: \${error.message}\\n\`);
  process.exit(1);
});
child.stdin.on("error", () => {});
process.stdin.on("error", () => {});
process.stdin.pipe(child.stdin);

// Backpressure: when BB's side of the pipe is full, pause the agent instead
// of buffering its output without limit.
let stdoutBlocked = false;
function writeOut(data) {
  if (!process.stdout.write(data) && !stdoutBlocked) {
    stdoutBlocked = true;
    child.stdout.pause();
    process.stdout.once("drain", () => {
      stdoutBlocked = false;
      child.stdout.resume();
    });
  }
}

// key = sessionId + toolCallId → the latest merged, not-yet-forwarded message.
const pending = new Map();
const timers = new Map();
const lastEmit = new Map();

// Throttle bookmarks are normally dropped when a tool call reaches a terminal
// status, but an agent that never completes its calls (crash, cancel, a long
// session of abandoned work) would otherwise grow this map for the life of
// the process. A bookmark older than one throttle window is behaviorally
// identical to no bookmark at all, so evicting it is free.
const MAX_BOOKMARKS = 4096;
function pruneBookmarks(now) {
  if (lastEmit.size <= MAX_BOOKMARKS) return;
  const floor = MAX_BOOKMARKS >> 1;
  for (const [key, at] of lastEmit) {
    // Insertion order is recency order (emit re-inserts every key it touches),
    // so the first entry too young to evict means every entry after it is too
    // young as well. Stopping there makes the scan O(evicted) rather than
    // O(size) — with the map at its ceiling, skipping instead of breaking
    // rescanned thousands of live entries on every single emit.
    if (now - at < THROTTLE_MS) break;
    lastEmit.delete(key);
    if (lastEmit.size <= floor) break;
  }
}

const TERMINAL_STATUS = new Set(["completed", "failed", "cancelled"]);

function emit(key) {
  const message = pending.get(key);
  if (message === undefined) return;
  pending.delete(key);
  const timer = timers.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(key);
  }
  const now = Date.now();
  // delete+set keeps Map insertion order aligned with recency, which is what
  // lets pruneBookmarks stop at the first entry it cannot evict.
  lastEmit.delete(key);
  lastEmit.set(key, now);
  pruneBookmarks(now);
  writeOut(JSON.stringify(message) + "\\n");
}

function flushAll() {
  for (const key of [...pending.keys()]) emit(key);
}

/** Non-null only for agent-notification tool_call_update messages. */
function coalescableKey(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.method !== "session/update" || "id" in message) return null;
  const update = message.params?.update;
  if (update === null || typeof update !== "object") return null;
  if (update.sessionUpdate !== "tool_call_update") return null;
  if (typeof update.toolCallId !== "string") return null;
  return String(message.params.sessionId) + "\\u0000" + update.toolCallId;
}

function handleLine(line) {
  if (line.length === 0) return;
  let message = null;
  try {
    message = JSON.parse(line);
  } catch {
    message = null;
  }
  const key = message === null ? null : coalescableKey(message);
  if (key === null) {
    // Anything else — responses, requests, other session updates, unparsable
    // lines — flushes held state first so observable ordering is preserved.
    flushAll();
    writeOut(line + "\\n");
    return;
  }

  const held = pending.get(key);
  if (held !== undefined) {
    // ACP update fields replace prior values, so field-level merge is
    // lossless. Spread copies own properties with define semantics, so a
    // hostile "__proto__" key stays inert data.
    held.params.update = { ...held.params.update, ...message.params.update };
    if (TERMINAL_STATUS.has(message.params.update.status)) {
      emit(key);
      // A terminal status ends the tool call; dropping its throttle bookmark
      // keeps memory bounded by ACTIVE tool calls over a long session.
      lastEmit.delete(key);
    }
    return;
  }
  if (TERMINAL_STATUS.has(message.params.update.status)) {
    pending.set(key, message);
    emit(key);
    lastEmit.delete(key);
    return;
  }
  const sinceLast = Date.now() - (lastEmit.get(key) ?? 0);
  pending.set(key, message);
  if (sinceLast >= THROTTLE_MS) {
    emit(key);
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(key);
    emit(key);
  }, THROTTLE_MS - sinceLast);
  timers.set(key, timer);
}

// The decoder is what makes multi-byte UTF-8 safe across chunk boundaries: a
// character split by the pipe is held back until its bytes complete, never
// mangled into replacement characters.
const decoder = new StringDecoder("utf8");
let buffer = "";
// True while discarding an oversized line: bytes stream through verbatim
// until its terminating newline, keeping memory bounded and output complete.
let overflowing = false;

// One pipe chunk becomes one write syscall: cork() batches every writeOut
// produced by this chunk into a single writev at uncork(). Nothing is deferred
// past the current tick — the bracket wraps one synchronous handler, so no
// timer can interleave — and ordering, backpressure and latency are unchanged.
// Trade-off: ~1.75us per pipe chunk, so a small loss when a chunk carries a
// single line (paced token streaming) and a large win once chunks are dense.
// Chunks are dense exactly when BB is reading slowly and the pipe backs up,
// which is the regime this proxy exists for.
child.stdout.on("data", (chunk) => {
  process.stdout.cork();
  try {
    onChunk(chunk);
  } finally {
    process.stdout.uncork();
  }
});

function onChunk(chunk) {
  let text = decoder.write(chunk);
  if (overflowing) {
    const newline = text.indexOf("\\n");
    if (newline === -1) {
      writeOut(text);
      return;
    }
    writeOut(text.slice(0, newline + 1));
    overflowing = false;
    text = text.slice(newline + 1);
  }
  // Scan only the NEWLY ARRIVED text for newlines. Searching the accumulated
  // buffer instead forces V8 to flatten the held cons-string on every chunk —
  // an O(buffer) copy per chunk, i.e. quadratic in the length of one long
  // line. A 30MB single-line tool output cost ~1.4s of CPU and ~394MB RSS
  // that way; scanning the chunk makes it ~0.12s and ~207MB.
  //
  // The invariant is unchanged: buffer holds exactly the bytes since the
  // last newline. It is now only appended to and cleared, never searched, so
  // the overflow check below, the passthrough state, and the tail handling in
  // 'end' all observe identical values (.length on a cons string is O(1), so
  // the single flatten happens once inside JSON.parse instead of per chunk).
  let start = 0;
  let newline;
  while ((newline = text.indexOf("\\n", start)) !== -1) {
    const line = buffer + text.slice(start, newline);
    buffer = "";
    start = newline + 1;
    handleLine(line);
  }
  buffer += text.slice(start);
  if (buffer.length > MAX_LINE_BYTES) {
    // Too large to hold: preserve ordering, then pass the partial line
    // through and stay transparent until it ends.
    flushAll();
    writeOut(buffer);
    buffer = "";
    overflowing = true;
  }
}
child.stdout.on("end", () => {
  const tail = buffer + decoder.end();
  buffer = "";
  if (overflowing) {
    // Terminate the oversized line even when the agent did not, so the last
    // thing BB reads is a complete line rather than a dangling fragment.
    writeOut(tail + "\\n");
    overflowing = false;
  } else if (tail.length > 0) {
    handleLine(tail);
  }
  flushAll();
});

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of FORWARDED_SIGNALS) {
  process.on(signal, () => child.kill(signal));
}

// Teardown is bound to 'close', not 'exit': 'exit' fires as soon as the agent
// is reaped, which can precede the stdout 'end' handler above, so tearing down
// there would drop whatever was still in flight. 'close' fires only once every
// stdio stream has been drained and ended.
let finishing = false;
function finish(code, signal) {
  if (finishing) return;
  finishing = true;
  flushAll();
  // The stdin pipe would otherwise keep this process alive after the agent
  // is gone.
  process.stdin.destroy();

  const die = () => {
    if (signal !== null && signal !== undefined) {
      // Re-raise cleanly: our own forwarding handler must not intercept it.
      for (const forwarded of FORWARDED_SIGNALS) process.removeAllListeners(forwarded);
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 0;
  };

  // stdout is a pipe, so its writes are asynchronous: dying immediately would
  // discard everything handed to libuv but not yet in the OS pipe — the agent
  // being killed is exactly when that queue is most likely to be non-empty.
  // end() flushes what is queued and then calls back; the guard covers a
  // reader that has gone away or stopped consuming.
  const guard = setTimeout(die, 2_000);
  guard.unref();
  try {
    process.stdout.end(() => {
      clearTimeout(guard);
      die();
    });
  } catch {
    clearTimeout(guard);
    die();
  }
}

child.on("close", (code, signal) => finish(code, signal));
`;

/**
 * Write the wrapper to `<homeDir>/${WRAPPER_HOME_RELATIVE_PATH}` and return
 * its absolute path. Content-diff guarded like the logo, so reloads and
 * repeated syncs do not churn the file.
 */
export function materializeWrapper(homeDir: string): string {
  const target = join(homeDir, WRAPPER_HOME_RELATIVE_PATH);
  let existing: string | null = null;
  try {
    existing = readFileSync(target, "utf8");
  } catch {
    existing = null;
  }
  if (existing !== WRAPPER_SOURCE) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, WRAPPER_SOURCE, { encoding: "utf8", mode: 0o644 });
  }
  return target;
}
