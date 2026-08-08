// Runtime stand-in for the host-supplied "@bb/plugin-sdk" module, used only
// under vitest (see vitest.config.ts). BB injects the real module when it
// loads server.ts; outside BB only these two runtime exports exist, and
// `defineRpcContract` is declared by the SDK as the identity function:
//
//   declare function defineRpcContract<const C extends PluginRpcContract>(contract: C): C;
//
// Types still come from types/bb-plugin-sdk.d.ts via the tsconfig path map —
// this shim is deliberately runtime-only and must stay dependency-free.

export function defineRpcContract<const Contract>(contract: Contract): Contract {
  return contract;
}

export const PLUGIN_CLI_OUTPUT_MAX_BYTES = 1_048_576;
