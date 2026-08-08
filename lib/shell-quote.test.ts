import { execFile } from "node:child_process";

import { describe, expect, it } from "vitest";

import { shellQuote } from "./shell-quote";

/** Ground truth: what does /bin/sh actually hand the program? */
function shWordsOf(commandLine: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/sh",
      ["-c", `printf '%s\\n' ${commandLine}`],
      (error, stdout) =>
        error === null ? resolve(stdout.split("\n").slice(0, -1)) : reject(error),
    );
  });
}

describe("shellQuote", () => {
  it("leaves ordinary command paths readable", () => {
    expect(shellQuote("kimi")).toBe("kimi");
    expect(shellQuote("/usr/local/bin/kimi")).toBe("/usr/local/bin/kimi");
    expect(shellQuote("/opt/kimi-0.34.0/bin/kimi")).toBe("/opt/kimi-0.34.0/bin/kimi");
  });

  it("quotes the empty string rather than dropping the word", () => {
    expect(shellQuote("")).toBe("''");
  });

  it.each([
    ["/opt/tools dir/kimi", "spaces"],
    ["/tmp/$(touch /tmp/pwned)/kimi", "command substitution"],
    ["/tmp/`touch /tmp/pwned`/kimi", "backticks"],
    ["/tmp/$HOME/kimi", "variable expansion"],
    ["/tmp/a;rm -rf ~/kimi", "command separator"],
    ["/tmp/it's here/kimi", "embedded single quote"],
    ["/tmp/back\\slash/kimi", "backslash"],
    ["/tmp/a|b&c>d<e/kimi", "pipes and redirection"],
    ["/tmp/new\nline/kimi", "newline"],
  ])("round-trips %s through a real shell untouched (%s)", async (path) => {
    // The word the shell parses out must be EXACTLY the input — one word,
    // no expansion, no side effects.
    const words = await shWordsOf(shellQuote(path));
    expect(words).toEqual(path.split("\n")); // printf %s\n re-splits the newline case
  });

  it("neutralizes what the old JSON.stringify scheme let through", async () => {
    // Double quotes keep $() live — the exact bug class this module replaces.
    const hostile = "/tmp/$(echo INJECTED)/kimi";
    const oldScheme = await shWordsOf(JSON.stringify(hostile));
    expect(oldScheme[0]).toContain("INJECTED"); // demonstrates the flaw
    const newScheme = await shWordsOf(shellQuote(hostile));
    expect(newScheme[0]).toBe(hostile); // and the fix
  });
});
