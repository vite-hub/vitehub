import { installsPackage } from "@vite-hub/internal/build/vite"
import { evlogBridgeKey } from "@vite-hub/internal/runtime/request-log"

import { generatedNitroPlugin } from "./generated-nitro-plugin.ts"

import type { Plugin } from "vite"

/**
 * Render the Nitro plugin that gives ViteHub packages evlog's standalone logger, for failures and Schedule runs outside
 * a request. It does nothing when the app does not register evlog's Nitro module, which sets `runtimeConfig.evlog`, or
 * turns it off with `enabled: false`. It imports evlog only then.
 */
export function renderEvlogBridgeNitroPlugin(): string {
  return [
    `import { useRuntimeConfig } from "nitro/runtime-config"`,
    "",
    `const key = Symbol.for(${JSON.stringify(evlogBridgeKey)})`,
    "",
    "export default async function viteHubEvlogBridge(nitroApp) {",
    "  delete globalThis[key]",
    "  const config = useRuntimeConfig().evlog",
    "  if (!config || config.enabled === false) return",
    "  const { createLogger, isEnabled } = await import(\"evlog\")",
    "  const bridge = {",
    "    createLogger,",
    "    isEnabled,",
    "    drain: event => nitroApp.hooks.callHook(\"evlog:drain\", { event }),",
    "  }",
    "  globalThis[key] = bridge",
    "  nitroApp.hooks.hook(\"close\", () => {",
    "    if (globalThis[key] === bridge) delete globalThis[key]",
    "  })",
    "}",
    "",
  ].join("\n")
}

/** Register the evlog bridge when the app installs evlog. Without evlog, ViteHub packages print to the console. */
export function evlogBridgeVitePlugin(): Plugin {
  return generatedNitroPlugin("vite-hub/evlog-bridge", "evlog-bridge.mjs", renderEvlogBridgeNitroPlugin, {
    when: root => installsPackage(root, "evlog"),
  })
}
