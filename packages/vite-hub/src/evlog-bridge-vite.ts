import { installsPackage } from "@vite-hub/internal/build/vite"
import { evlogBridgeKey } from "@vite-hub/internal/runtime/request-log"

import { generatedNitroPlugin } from "./generated-nitro-plugin.ts"

import type { Plugin } from "vite"

/**
 * Render the Nitro plugin that gives ViteHub packages evlog's standalone logger, for failures and Schedule runs outside
 * a request. It does nothing when the app does not register evlog's Nitro module, which sets `runtimeConfig.evlog`.
 */
export function renderEvlogBridgeNitroPlugin(): string {
  return [
    `import { createLogger } from "evlog"`,
    `import { useRuntimeConfig } from "nitro/runtime-config"`,
    "",
    "export default function viteHubEvlogBridge(nitroApp) {",
    "  if (!useRuntimeConfig().evlog) return",
    `  globalThis[Symbol.for(${JSON.stringify(evlogBridgeKey)})] = {`,
    "    createLogger,",
    // evlog sends a standalone event to its global drains only. Request events also reach the `evlog:drain` hooks.
    "    drain: event => nitroApp.hooks.callHook(\"evlog:drain\", { event }),",
    "  }",
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
