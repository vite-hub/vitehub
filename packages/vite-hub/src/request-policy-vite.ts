import { ownModule } from "@vite-hub/internal/build/paths"
import { generatedNitroPlugin } from "./generated-nitro-plugin.ts"
import { securityHeadersNitroModule, type ResolvedSecurity } from "./security-vite.ts"

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

/**
 * Render the Nitro plugin that installs `trustProxy`, `sameOriginWrites`, and `security`. `security` wraps
 * `nitroApp.fetch` last, so a 403 from `sameOriginWrites` also gets the security headers.
 */
export function renderRequestPolicyNitroPlugin(options: RequestPolicyOptions, security?: ResolvedSecurity): string {
  const requestPolicy = Boolean(options.trustProxy || options.sameOriginWrites)
  return [
    ...requestPolicy ? [`import { installRequestPolicy } from ${JSON.stringify(ownModule(import.meta.url, "_internal/runtime/request-policy"))}`] : [],
    ...security ? [`import { installSecurity } from ${JSON.stringify(ownModule(import.meta.url, "_internal/runtime/security"))}`] : [],
    "",
    "export default function viteHubRequestPolicyPlugin(nitroApp) {",
    ...requestPolicy ? [`  installRequestPolicy(nitroApp, ${JSON.stringify(options)})`] : [],
    ...security ? [renderInstallSecurity(security)] : [],
    "}",
    "",
  ].join("\n")
}

function renderInstallSecurity({ headers, devHeaders, maxBodySize }: ResolvedSecurity): string {
  // With only the default headers, `vite dev` installs nothing.
  if (devHeaders.length === 0 && maxBodySize === undefined) return `  if (!import.meta.dev) installSecurity(nitroApp, { headers: ${JSON.stringify(headers)} })`
  return `  installSecurity(nitroApp, { headers: import.meta.dev ? ${JSON.stringify(devHeaders)} : ${JSON.stringify(headers)}${maxBodySize === undefined ? "" : `, maxBodySize: ${maxBodySize}`} })`
}

/**
 * Install the policy synchronously before other Nitro plugins can defer initialization. Server entries capture
 * `nitroApp.fetch` immediately, so installing after an async plugin would leave that captured entry unprotected.
 */
export function requestPolicyVitePlugin(options: { trustProxy?: boolean, sameOriginWrites?: boolean | SameOriginWritesOptions }, security: ResolvedSecurity | undefined): Plugin {
  const sameOriginWrites = options.sameOriginWrites
  const policy: RequestPolicyOptions = {
    trustProxy: options.trustProxy === true,
    sameOriginWrites: sameOriginWrites ? { exclude: sameOriginWrites === true ? [] : sameOriginWrites.exclude ?? [] } : false,
  }
  const headers = security?.headers ?? []
  return generatedNitroPlugin("vite-hub/request-policy", "request-policy.mjs", () => renderRequestPolicyNitroPlugin(policy, security), {
    position: "start",
    ...headers.length > 0
      ? { configure: (nitro: Record<string, unknown>) => { nitro.modules = [...Array.isArray(nitro.modules) ? nitro.modules : [], securityHeadersNitroModule(headers)] } }
      : {},
  })
}
