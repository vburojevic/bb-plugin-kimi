// The provider icon BB renders next to "Codex", "Claude Code", and "Cursor".
//
// Matching BB's provider-icon convention, which its own icons establish:
// a FLAT, TRANSPARENT, edge-to-edge glyph in a 24x24 box — not an app-icon
// tile. BB's built-ins are inline SVG components filling the full box with
// `fill="currentColor"`, tinted per provider (`claude-code` -> #D97757,
// `pi` -> #6D5DFB, `acp-opencode` -> #2563EB, `acp-cursor` -> #111827 with
// #F5F5F5 in dark mode).
//
// A custom ACP agent's `logo` is rendered as an <img> (BB inlines a component
// only for built-ins and its four known ACP agents), so it can NEVER inherit
// `currentColor` and can never know which BB theme is active. A fixed color is
// therefore the only option, and the goal is to be unobtrusive in every theme
// rather than exact in one.
//
// Hence a neutral mid grey chosen to sit at or just below a typical
// muted-foreground, so the icon never out-shouts its neighbours:
//
//   BB default dark  --muted-foreground oklch(78% 0 0)  ~#B7B7B7  (luma 183)
//   Ayu Dark         measured                            #9A9193  (luma 148)
//   this glyph       dark                                #9A9A9A  (luma 154)
//
// An earlier version used BB's Cursor pair (#111827 / #F5F5F5). On Ayu Dark
// that rendered brighter than the theme's own foreground (#BFBDB6) and stood
// out badly. Being slightly dimmer than neighbours reads as muted; being
// brighter reads as broken.
//
// Monochrome on purpose: no other provider icon in the row carries a colour
// accent, so Kimi's brand blue is dropped here and kept only where the full
// mark belongs. The literal `fill` on the <g> is the fallback for renderers
// that ignore the media query.
//
// The K is a contour trace of the official Kimi Code mark published at
// moonshotai.github.io/kimi-code (assets/Kimi.CThWxdLR.png, 316x316),
// simplified to 18 points at 97.5% shape IoU. The black tile, white K, brand
// blue dot, and grain texture are all dropped: they belong to an app icon, not
// to this row.
//
// "Kimi" and the Kimi mark are trademarks of Moonshot AI.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOGO_FILE_NAME = "kimi-code.svg";

export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" role="img" aria-label="Kimi Code">
  <style>
    .kimi-ink { fill: #5F5F5F; }
    @media (prefers-color-scheme: dark) { .kimi-ink { fill: #9A9A9A; } }
  </style>
  <g class="kimi-ink" fill="#5F5F5F">
    <path d="M0.25 4.838L3.474 4.838L3.598 13.767L4.094 13.767L12.899 4.838L17.612 4.962L9.179 13.395L9.179 13.891L15.999 18.852L18.108 19.471L18.108 23.316L16.868 23.192L14.511 22.2L6.698 16.371L3.474 19.348L3.474 23.316L0.25 23.316L0.25 4.962Z"/>
    <circle cx="21.58" cy="2.854" r="2.17"/>
  </g>
</svg>
`;

/**
 * Materialize the bundled logo into the plugin's own data directory and return
 * its absolute path.
 *
 * Server-local plugin data, so `node:fs` is the correct primitive here (the
 * multi-machine `bb.sdk.files` rule covers user-supplied paths, not this).
 * Writes only when the content differs, so reloads do not churn the file.
 */
export function materializeLogo(pluginDataDir: string): string {
  const target = join(pluginDataDir, LOGO_FILE_NAME);
  let existing: string | null = null;
  try {
    existing = readFileSync(target, "utf8");
  } catch {
    existing = null;
  }
  if (existing !== LOGO_SVG) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, LOGO_SVG, "utf8");
  }
  return target;
}

/** `<dataDir>/plugins/<pluginId>` — where BB already keeps this plugin's db and secrets. */
export function pluginDataDir(dataDir: string, pluginId: string): string {
  return join(dataDir, "plugins", pluginId);
}
