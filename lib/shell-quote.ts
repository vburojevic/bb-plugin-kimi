// POSIX shell quoting for the one place this plugin composes a SHELL STRING
// rather than an argv array: the login terminal's command line.
//
// The previous scheme quoted with JSON.stringify and only when the path
// contained whitespace. That is wrong twice over: double quotes leave \`$\`,
// backticks, and backslashes live for the shell, and a path with
// metacharacters but no whitespace (\`/tmp/$(x)/kimi\`) went out with no
// quoting at all. Settings are same-user trusted in BB's model, so this is
// defense-in-depth — but a terminal running a corrupted command line is also
// just a broken login flow.

/** Characters that need no quoting in any POSIX shell word position. */
const SAFE_WORD = /^[A-Za-z0-9_\-./+:=@]+$/u;

/**
 * Quote one word for /bin/sh. Safe words pass through untouched so the
 * terminal shows a command the user can read and retype; everything else is
 * single-quoted, the only POSIX quoting form with zero live metacharacters.
 * Embedded single quotes use the standard close-escape-reopen dance.
 */
export function shellQuote(word: string): string {
  if (word.length > 0 && SAFE_WORD.test(word)) return word;
  return `'${word.replaceAll("'", String.raw`'\''`)}'`;
}
