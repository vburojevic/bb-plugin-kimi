import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // BB injects "@bb/plugin-sdk" when it loads the plugin; under vitest the
      // runtime shim stands in (types keep flowing from the tsconfig path map).
      "@bb/plugin-sdk": fileURLToPath(new URL("./test/shims/bb-plugin-sdk.ts", import.meta.url)),
    },
  },
  test: {
    // The wrapper/snippet/probe suites spawn real processes; a generous
    // per-test ceiling keeps a wedged child from hanging the whole run.
    testTimeout: 30_000,
  },
});
