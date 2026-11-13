import { ownModule } from "@vite-hub/internal/build/paths"
import { generatedNitroPlugin } from "./generated-nitro-plugin.ts"

import type { Plugin } from "vite"
import type { RequestPolicyOptions } from "./_internal/runtime/request-policy.ts"

/** `sameOriginWrites` options of `vitehub()`. */
export interface SameOriginWritesOptions {
  /**
   * Path prefixes that take writes from other sites, such as `/api/forms/contact` for a Form with `origins`. A prefix
   * matches the path itself and the paths below it.
   */
  exclude?: string[]
}

/** Render the Nitro plugin that installs `trustProxy` and `sameOriginWrites`. */
export function renderRequestPolicyNitroPlugin(options: RequestPolicyOptions): string {
  return [
    `import { installRequestPolicy } from ${JSON.stringify(ownModule(import.meta.url, "_internal/runtime/request-policy"))}`,
    "",
    "export default function viteHubRequestPolicyPlugin(nitroApp) {",
    `  installRequestPolicy(nitroApp, ${JSON.stringify(options)})`,
    "}",
    "",
  ].join("\n")
}

/**
 * Register the request policy after the other generated plugins, so its `fetch` wrapper answers a cross-origin write
 * before theirs run. Its `request` hook still goes before theirs.
 */
export function requestPolicyVitePlugin(options: { trustProxy?: boolean, sameOriginWrites?: boolean | SameOriginWritesOptions }): Plugin {
  const sameOriginWrites = options.sameOriginWrites
  const policy: RequestPolicyOptions = {
    trustProxy: options.trustProxy === true,
    sameOriginWrites: sameOriginWrites ? { exclude: sameOriginWrites === true ? [] : sameOriginWrites.exclude ?? [] } : false,
  }
  return generatedNitroPlugin("vite-hub/request-policy", "request-policy.mjs", () => renderRequestPolicyNitroPlugin(policy))
}
