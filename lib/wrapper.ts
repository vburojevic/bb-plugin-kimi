// The tool-call-progress coalescer that sits between BB and `kimi acp`.
//
// Since 0.2.0 the wrapper also owns session-load healing. Kimi's `session/load`
// validates the WORKSPACE ROOT RECORDED WHEN THE SESSION WAS CREATED — not the
// cwd BB passes on resume. BB routinely destroys and re-provisions worktree
// environments, so resuming any thread whose original directory is gone fails
// with "workspace root <path> does not exist"; BB's ACP bridge swallows that
// error and silently continues in a FRESH session, i.e. the agent loses every
// previous message. The wrapper sees both sides of the wire, so it can fix
// this where it happens: it remembers in-flight `session/load` requests, and
// when the agent answers one with that specific error it recreates the missing
// directory (confined to $HOME) and retries the load once, transparently —
// BB receives a single successful response under its original request id.
//
// Why it exists: BB's ACP bridge persists EVERY `session/update` notification
// as a row in its event store. Kimi Code streams a `tool_call_update` snapshot
// for each terminal-output tick, so one long command execution can write tens
// of thousands of ~4KB rows — a single day-long thread once grew bb.db past
// half a gigabyte and pinned the server's main thread in synchronous SQLite
// scans. Kimi also streams one tiny `agent_thought_chunk` per token-ish tick
// of reasoning, which is the same firehose on a second channel (measured:
// ~15k persisted rows in one 30-minute thread). The agent cannot be told to
// stream less, and the bridge is BB core, so the one seam this plugin owns is
// the spawned process itself: register a wrapper instead of the bare CLI and
// thin the firehose in transit.
//
// Losslessness: ACP `tool_call_update` fields REPLACE the tool call's previous
// values (they are partial snapshots, not deltas), so merging a run of updates
// per (sessionId, toolCallId) — newer fields over older — and emitting the
// merged snapshot is semantically identical to delivering every tick. Thought
// chunks are the opposite: their text APPENDS to the session's open reasoning
// item (BB itself concatenates every delta it receives), so merging a
// contiguous run of chunks into their concatenation is identical too. Message
// chunks stay untouched: they are coarse already and the user reads them
// live. Terminal statuses flush immediately, and any non-coalescable message
// flushes all held state first, so relative ordering BB can observe — and the
// reasoning-item boundaries it derives from tool_call/message/turn edges — is
// preserved.
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
// ACP stdio proxy for bb-plugin-kimi. Three jobs:
//  1. Coalesce tool_call_update notifications so BB persists snapshots at most
//     every KIMI_COALESCE_MS (default 500ms) per tool call, instead of one
//     event per output tick.
//  2. Coalesce agent_thought_chunk notifications the same way per session —
//     Kimi streams one tiny reasoning delta per token-ish tick and BB persists
//     each one, which is the same event-store firehose on a second channel.
//     Deltas append, so merging concatenates their text (lossless); message
//     chunks stay untouched.
//  3. Heal session/load failures caused by a missing workspace root (BB
//     destroys worktree environments; Kimi validates the session's original
//     directory) by recreating the directory and retrying the load once —
//     without this, resumed threads silently lose their entire history.
// Managed by bb-plugin-kimi — edits are overwritten on the next provider sync.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
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
// Session-load healing is on unless explicitly disabled.
const HEAL = process.env.KIMI_SESSION_LOAD_HEAL !== "0";
// Longest client line held for parsing; session/load requests are tiny, so
// anything longer (a prompt with embedded context) is forwarded unexamined.
const CLIENT_PARSE_MAX = 1024 * 1024;

const child = spawn(REAL, process.argv.slice(2), {
  stdio: ["pipe", "pipe", "inherit"],
});
child.on("error", (error) => {
  process.stderr.write(\`acp-coalesce: could not start \${REAL}: \${error.message}\\n\`);
  process.exit(1);
});
child.stdin.on("error", () => {});
process.stdin.on("error", () => {});

// --- session-load healing ----------------------------------------------------
//
// BB -> agent traffic is forwarded byte-for-byte, but a decoded copy is also
// line-split so in-flight session/load requests can be remembered. When the
// agent rejects one because the session's recorded workspace root no longer
// exists, the wrapper recreates that directory (inside $HOME only), replays
// the identical request under a wrapper-owned id, and forwards the retry's
// response to BB under the original id. BB is dropping replayed notifications
// while its load request is unresolved either way, so the extra replay the
// retry produces is invisible to it.

/** Ids can be numbers or strings; the key preserves the distinction. */
function idKey(id) {
  return typeof id + ":" + String(id);
}

// idKey(request id) -> the parsed session/load request (for the retry replay).
const loadRequestsById = new Map();
// idKey(retry id) -> { originalId, heldErrorLine } for in-flight retries.
const retriesByAgentId = new Map();
let retrySequence = 0;

function rememberClientLine(line) {
  if (!HEAL || line.length === 0) return;
  let message = null;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) return;
  if (message.method !== "session/load" || !("id" in message)) return;
  loadRequestsById.set(idKey(message.id), message);
  // Bounded: the bridge runs one load at a time, so anything beyond a handful
  // of unanswered entries is a leak from a client that vanished mid-request.
  if (loadRequestsById.size > 32) {
    const oldest = loadRequestsById.keys().next().value;
    loadRequestsById.delete(oldest);
  }
}

/**
 * The workspace-root path this error makes healable, or null.
 * Confined to $HOME: the path is data from another process, so anything not
 * strictly inside the home directory (or containing traversal segments) is
 * refused and the original error passes through.
 */
function healableWorkspacePath(message) {
  const error = message.error;
  if (error === null || typeof error !== "object") return null;
  const details =
    typeof error.data?.details === "string"
      ? error.data.details
      : typeof error.message === "string"
        ? error.message
        : "";
  const match = details.match(/workspace root (.+?) does not exist/);
  if (match === null) return null;
  const path = match[1];
  const home = process.env.HOME ?? "";
  if (home.length === 0 || !path.startsWith(home + "/")) return null;
  if (path.includes("\\u0000") || path.split("/").includes("..")) return null;
  return path;
}

/**
 * Handle an agent->BB response that belongs to the healing flow. Returns true
 * when the line was consumed (held or rewritten) and must not be forwarded.
 */
function interceptAgentResponse(message, line) {
  if (!HEAL) return false;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
  if (!("id" in message) || typeof message.method === "string") return false;
  const key = idKey(message.id);

  const retry = retriesByAgentId.get(key);
  if (retry !== undefined) {
    // Whatever the retry produced — success or a different failure — BB gets
    // exactly one response, under the id it is actually waiting on.
    retriesByAgentId.delete(key);
    message.id = retry.originalId;
    flushAll();
    writeOut(JSON.stringify(message) + "\\n");
    return true;
  }

  const original = loadRequestsById.get(key);
  if (original === undefined) return false;
  loadRequestsById.delete(key);
  const workspacePath = healableWorkspacePath(message);
  if (workspacePath === null) return false;
  try {
    mkdirSync(workspacePath, { recursive: true });
  } catch {
    return false;
  }
  const retryId = \`__kimi_coalesce_retry__\${retrySequence++}\`;
  retriesByAgentId.set(idKey(retryId), { originalId: message.id, heldErrorLine: line });
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: retryId,
        method: "session/load",
        params: original.params,
      }) + "\\n",
    );
  } catch {
    retriesByAgentId.delete(idKey(retryId));
    return false;
  }
  process.stderr.write(
    \`acp-coalesce: recreated missing workspace root \${workspacePath}; retrying session/load\\n\`,
  );
  return true;
}

/** BB must never hang on a load whose retry the agent did not live to answer. */
function releaseHeldLoadErrors() {
  for (const retry of retriesByAgentId.values()) {
    writeOut(retry.heldErrorLine + "\\n");
  }
  retriesByAgentId.clear();
}

const clientDecoder = new StringDecoder("utf8");
let clientBuffer = "";
let clientOverflowing = false;
process.stdin.on("data", (chunk) => {
  // Forward the original bytes first — parsing failures can never affect the
  // wire. Backpressure mirrors what pipe() would do.
  if (!child.stdin.write(chunk)) {
    process.stdin.pause();
    child.stdin.once("drain", () => process.stdin.resume());
  }
  let text = clientDecoder.write(chunk);
  if (clientOverflowing) {
    const newline = text.indexOf("\\n");
    if (newline === -1) return;
    clientOverflowing = false;
    text = text.slice(newline + 1);
  }
  let start = 0;
  let newline;
  while ((newline = text.indexOf("\\n", start)) !== -1) {
    rememberClientLine(clientBuffer + text.slice(start, newline));
    clientBuffer = "";
    start = newline + 1;
  }
  clientBuffer += text.slice(start);
  if (clientBuffer.length > CLIENT_PARSE_MAX) {
    clientBuffer = "";
    clientOverflowing = true;
  }
});
process.stdin.on("end", () => {
  child.stdin.end();
});

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

// key → the latest merged, not-yet-forwarded message, tagged by stream kind.
// Two streams share this map, and Map insertion order (first-held order) is
// what lets flushAll emit held state in arrival order across both:
//
//  - tool_call_update snapshots (key prefix "tool", then sessionId and
//    toolCallId): ACP update fields REPLACE the tool call's previous values,
//    so merging is a field union with the newest value winning per field.
//  - agent_thought_chunk deltas (key prefix "thought", then sessionId): chunk
//    text APPENDS to the session's open reasoning item (BB itself
//    concatenates every delta it receives into that item), so merging a
//    contiguous run of chunks into their concatenation is identical. The
//    boundaries BB uses to close a reasoning item — a new tool_call, a
//    message chunk, turn end — are all non-coalescable, so they flush held
//    thought text before themselves and the run boundary lands exactly where
//    BB would put it.
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
  const entry = pending.get(key);
  if (entry === undefined) return;
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
  writeOut(JSON.stringify(entry.message) + "\\n");
}

function flushAll() {
  for (const key of [...pending.keys()]) emit(key);
}

/** Non-null only for coalescable agent session/update notifications. */
function coalescableTarget(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.method !== "session/update" || "id" in message) return null;
  const update = message.params?.update;
  if (update === null || typeof update !== "object") return null;
  if (update.sessionUpdate === "tool_call_update" && typeof update.toolCallId === "string") {
    return {
      kind: "tool",
      key:
        "tool\\u0000" +
        String(message.params.sessionId) +
        "\\u0000" +
        update.toolCallId,
    };
  }
  if (update.sessionUpdate === "agent_thought_chunk") {
    const content = update.content;
    if (
      content === null ||
      typeof content !== "object" ||
      content.type !== "text" ||
      typeof content.text !== "string"
    ) {
      // A thought chunk that is not plain text is not mergeable; it passes
      // through like any other update (and flushes held state first).
      return null;
    }
    return { kind: "thought", key: "thought\\u0000" + String(message.params.sessionId) };
  }
  return null;
}

function handleLine(line) {
  if (line.length === 0) return;
  let message = null;
  try {
    message = JSON.parse(line);
  } catch {
    message = null;
  }
  if (interceptAgentResponse(message, line)) return;
  const target = message === null ? null : coalescableTarget(message);
  if (target === null) {
    // Anything else — responses, requests, other session updates, unparsable
    // lines — flushes held state first so observable ordering is preserved.
    flushAll();
    writeOut(line + "\\n");
    return;
  }
  const key = target.key;
  const held = pending.get(key);
  if (held !== undefined) {
    if (target.kind === "thought") {
      // Only the text grows; the held envelope already carries sessionUpdate
      // and content.type, identical across the run.
      held.message.params.update.content.text += message.params.update.content.text;
      return;
    }
    // ACP update fields replace prior values, so field-level merge is
    // lossless. Spread copies own properties with define semantics, so a
    // hostile "__proto__" key stays inert data.
    held.message.params.update = { ...held.message.params.update, ...message.params.update };
    if (TERMINAL_STATUS.has(message.params.update.status)) {
      emit(key);
      // A terminal status ends the tool call; dropping its throttle bookmark
      // keeps memory bounded by ACTIVE tool calls over a long session.
      lastEmit.delete(key);
    }
    return;
  }
  if (target.kind === "tool" && TERMINAL_STATUS.has(message.params.update.status)) {
    pending.set(key, { kind: target.kind, message });
    emit(key);
    lastEmit.delete(key);
    return;
  }
  const sinceLast = Date.now() - (lastEmit.get(key) ?? 0);
  pending.set(key, { kind: target.kind, message });
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
  releaseHeldLoadErrors();
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
