import { ownModule } from "@vite-hub/internal/build/paths"
import { generatedNitroPlugin } from "./generated-nitro-plugin.ts"
import { resolveSecurityPolicy, securityHeadersNitroModule, type SecurityOptions } from "./security-vite.ts"

import type { Plugin } from "vite"
import type { RequestPolicyOptions } from "./_internal/runtime/request-policy.ts"
import type { SecurityPolicy } from "./_internal/runtime/security.ts"

/** `sameOriginWrites` options of `vitehub()`. */
export interface SameOriginWritesOptions {
  /**
   * Path prefixes that take writes from other sites, such as `/api/forms/contact` for a Form with `origins`. A prefix
   * matches the path itself and the paths below it.
   */
  exclude?: string[]
}

/**
 * Render the Nitro plugin that installs `trustProxy`, `sameOriginWrites`, and `security`. `security` wraps
 * `nitroApp.fetch` last, so a 403 from `sameOriginWrites` also gets the security headers.
 */
export function renderRequestPolicyNitroPlugin(options: RequestPolicyOptions, security?: SecurityPolicy): string {
  const requestPolicy = Boolean(options.trustProxy || options.sameOriginWrites)
  // `Strict-Transport-Security` only in built output: a browser that gets it from `vite dev` on a local name refuses http there for a year.
  const devHeaders = security?.headers.filter(([name]) => name.toLowerCase() !== "strict-transport-security")
  return [
    ...requestPolicy ? [`import { installRequestPolicy } from ${JSON.stringify(ownModule(import.meta.url, "_internal/runtime/request-policy"))}`] : [],
    ...security ? [`import { installSecurity } from ${JSON.stringify(ownModule(import.meta.url, "_internal/runtime/security"))}`] : [],
    "",
    "export default function viteHubRequestPolicyPlugin(nitroApp) {",
    ...requestPolicy ? [`  installRequestPolicy(nitroApp, ${JSON.stringify(options)})`] : [],
    ...security
      ? [`  installSecurity(nitroApp, { headers: import.meta.dev ? ${JSON.stringify(devHeaders)} : ${JSON.stringify(security.headers)}${security.maxBodySize === undefined ? "" : `, maxBodySize: ${security.maxBodySize}`} })`]
      : [],
    "}",
    "",
  ].join("\n")
}

/**
 * Install the policy synchronously before other Nitro plugins can defer initialization. Server entries capture
 * `nitroApp.fetch` immediately, so installing after an async plugin would leave that captured entry unprotected.
 */
export function requestPolicyVitePlugin(options: { trustProxy?: boolean, sameOriginWrites?: boolean | SameOriginWritesOptions, security?: SecurityOptions }): Plugin {
  const sameOriginWrites = options.sameOriginWrites
  const policy: RequestPolicyOptions = {
    trustProxy: options.trustProxy === true,
    sameOriginWrites: sameOriginWrites ? { exclude: sameOriginWrites === true ? [] : sameOriginWrites.exclude ?? [] } : false,
  }
  const security = resolveSecurityPolicy(options.security)
  const headers = security?.headers ?? []
  return generatedNitroPlugin("vite-hub/request-policy", "request-policy.mjs", () => renderRequestPolicyNitroPlugin(policy, security), {
    position: "start",
    ...headers.length > 0
      ? { configure: (nitro: Record<string, unknown>) => { nitro.modules = [...Array.isArray(nitro.modules) ? nitro.modules : [], securityHeadersNitroModule(headers)] } }
      : {},
  })
}
