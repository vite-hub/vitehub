import { generatedNitroPlugin } from "./generated-nitro-plugin.ts"

import type { Plugin } from "vite"

/** The `define` names that ViteHub package code reads at runtime. */
export const viteHubRuntimeDefines = [
  "__VITEHUB_AGENT_APP_ROOT__",
  "__VITEHUB_APP_BASE_URL__",
  "__VITEHUB_AUTH_APP_BASE_URL__",
  "__VITEHUB_PRESETS_BUILD_REVISION__",
  "__VITEHUB_PUBLIC_URL__",
] as const

/**
 * Render the Nitro plugin that sets ViteHub's `define` and Nitro `replace` values as globals in `vite dev`.
 * Vite and Nitro replace these names only in the code that Vite transforms. In `vite dev`, Node loads ViteHub packages
 * without Vite, so their `typeof __VITEHUB_*__` checks read these globals instead.
 * The plugin builds each global name at runtime, because the replacements also rewrite the name in a string.
 */
export function renderDevDefinesNitroPlugin(): string {
  return [
    "const defines = [",
    ...viteHubRuntimeDefines.map(name => `  [${JSON.stringify(name.slice("__VITEHUB_".length, -"__".length))}, typeof ${name} === "undefined" ? undefined : ${name}],`),
    "]",
    "for (const [name, value] of defines) if (value !== undefined) globalThis[`__VITEHUB_${name}__`] = value",
    "",
    "export default function viteHubDevDefinesPlugin() {}",
    "",
  ].join("\n")
}

/** Register the generated Nitro plugin first, so ViteHub packages read the globals from the first request. */
export function devDefinesVitePlugin(): Plugin {
  return { ...generatedNitroPlugin("vite-hub/dev-defines", "dev-defines.mjs", renderDevDefinesNitroPlugin, { position: "start" }), apply: "serve" }
}
