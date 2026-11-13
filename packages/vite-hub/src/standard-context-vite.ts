import { generatedNitroPlugin } from "./generated-nitro-plugin.ts"

import type { Plugin } from "vite"

/**
 * Render the Nitro plugin that sets `event["~standard"]` for each request, so ViteHub primitives read one
 * Standard Context. Delete it when H3 implements Standard Context.
 */
export function renderStandardContextNitroPlugin(): string {
  return [
    `import { installStandardContext } from "vite-hub/_internal/runtime/internal/h3"`,
    "",
    "export default function viteHubStandardContextPlugin(nitroApp) {",
    `  // HookableCore stores request callbacks in`,
    `  // an array, so prepend the installer to cover callbacks registered earlier.`,
    `  const requestHooks = nitroApp.hooks._hooks?.request`,
    `  if (Array.isArray(requestHooks)) requestHooks.unshift(installStandardContext)`,
    `  else nitroApp.hooks.hook("request", installStandardContext)`,
    "}",
    "",
  ].join("\n")
}

/** Add `~standard` to the app's H3Event type. */
const standardContextTypes = [
  `import type {} from "vite-hub/_internal/runtime/internal/h3"`,
  "",
  "export {}",
  "",
].join("\n")

/** Register the generated Nitro plugin first, so request hooks of other plugins can read `event["~standard"]`. */
export function standardContextVitePlugin(): Plugin {
  return generatedNitroPlugin("vite-hub/standard-context", "standard-context.mjs", renderStandardContextNitroPlugin, {
    position: "start",
    types: standardContextTypes,
  })
}
