import { generatedNitroPlugin } from "./generated-nitro-plugin.ts"

import type { Plugin } from "vite"

/**
 * Render the Nitro plugin that sets `event["~standard"]` for each request, so ViteHub primitives read one
 * Standard Context on H3 1 and H3 2. Delete it when H3 implements Standard Context.
 */
export function renderStandardContextNitroPlugin(): string {
  return [
    `import { installStandardContext } from "vite-hub/runtime/h3"`,
    "",
    "export default function viteHubStandardContextPlugin(nitroApp) {",
    `  nitroApp.hooks.hook("request", installStandardContext)`,
    "}",
    "",
  ].join("\n")
}

/** Add `~standard` to the app's H3Event type. */
const standardContextTypes = [
  `import type {} from "vite-hub/runtime/h3"`,
  "",
  "export {}",
  "",
].join("\n")

/** Register the generated Nitro plugin first, so request hooks of other plugins can read `event["~standard"]`. */
export function standardContextVitePlugin(): Plugin {
  return generatedNitroPlugin("vite-hub/standard-context", "standard-context.mjs", renderStandardContextNitroPlugin, {
    position: "start",
    types: standardContextTypes,
    configure(nitro) {
      const hooks = (nitro.hooks ??= {}) as Record<string, unknown>
      const existing = hooks.request
      hooks.request = async (event: unknown, ...args: unknown[]) => {
        const module = await import("vite-hub/runtime/h3")
        const install: (event: object) => void = module.installStandardContext
        if (event === null || (typeof event !== "object" && typeof event !== "function")) return
        install(event)
        if (typeof existing === "function") return Reflect.apply(existing, undefined, [event, ...args])
        if (Array.isArray(existing)) {
          for (const handler of existing) {
            if (typeof handler === "function") await Reflect.apply(handler, undefined, [event, ...args])
          }
        }
      }
    },
  })
}
