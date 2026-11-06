import { installOperationSectionResolver } from "@vite-hub/internal/operation-registry"
import { isRuntimeResponse } from "@vite-hub/runtime/internal/runtime-type"

import { isConsoleDevelopmentBuild } from "./development.ts"

import type { ConsoleUser } from "../../auth-types.ts"
import type { ConsoleSectionId } from "../sections.ts"
import type { ConsoleAccessMode, ConsoleAccessPolicy } from "./access.ts"

/**
 * The Console access policy store. Generated output installs the policy when the server starts, so this module holds
 * only the policy and its checks. The request checks in `access.ts` load with the first Console route.
 */
const policyKey: unique symbol = Symbol.for("vitehub.console.access")
const openWarningKey: unique symbol = Symbol.for("vitehub.console.access.open-warning")
// SAFETY: This module owns the process slot shared by separately bundled generated plugins and Console routes.
const scope = globalThis as typeof globalThis & { [policyKey]?: ConsoleAccessPolicy, [openWarningKey]?: true }
const modes = new Set<ConsoleAccessMode>(["auth", "cloudflare-access", "local", "open"])

export const consoleOpenAccessWarning = "[vitehub] console: { auth: false } has no sign-in. Anyone who can reach /_vitehub can use the Console. Set console.auth to \"app\" or a Console Auth config, or set console.authorize."

/** Install the Console access policy. Generated Console output calls this before it serves a request. */
export function installConsoleAccess(policy: ConsoleAccessPolicy): void {
  if (!(policy instanceof Object) || !modes.has(policy.mode)) {
    throw new TypeError("[vitehub] Console access requires a known access mode.")
  }
  if ("check" in policy && policy.check !== undefined && typeof policy.check !== "function") {
    throw new TypeError("[vitehub] Console access check must be a function.")
  }
  if ("authorize" in policy && policy.authorize !== undefined && typeof policy.authorize !== "function") {
    throw new TypeError("[vitehub] console.authorize must default-export a function.")
  }
  if ("user" in policy && policy.user !== undefined && typeof policy.user !== "function") {
    throw new TypeError("[vitehub] Console access user reader must be a function.")
  }
  if ("signInPage" in policy && policy.signInPage !== undefined && !isConsoleSignInPage(policy.signInPage)) {
    throw new TypeError("[vitehub] The Console sign-in page must be a path on the same origin, such as /sign-in.")
  }
  if ("impersonation" in policy && policy.impersonation !== undefined && typeof policy.impersonation !== "boolean") {
    throw new TypeError("[vitehub] console.impersonation must be true or false.")
  }
  if (policy.mode === "open" && !policy.authorize && !isConsoleDevelopmentBuild() && !scope[openWarningKey]) {
    scope[openWarningKey] = true
    globalThis.console?.warn(consoleOpenAccessWarning)
  }
  scope[policyKey] = Object.freeze({ ...policy })
  installOperationSectionResolver(async ({ user }) => {
    if (policy.mode === "local" || !policy.authorize) return "all"
    // Agents have no browser request, so `authorize` gets one without headers and the user that the Actor stands for.
    const request = new Request("http://vitehub.local/_vitehub/rpc/__call", { method: "POST" })
    const result: unknown = await policy.authorize(user ? { request, user: user as ConsoleUser } : { request })
    if (result === true) return "all"
    return isRuntimeResponse(result) ? [] : consoleAuthorizedSections(result) ?? []
  })
}

export function installedConsoleAccessPolicy(): ConsoleAccessPolicy | undefined {
  return scope[policyKey]
}

/** Whether a value stays a path on the same origin after URL normalization. */
export function isConsoleSignInPage(value: unknown): value is string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The value comes from configuration or generated output.
  if (typeof value !== "string" || !/^\/(?!\/)[^\\\s]*$/.test(value)) return false
  // Dot segments can turn a single-slash input into a network-path reference when serialized.
  return !new URL(value, "http://vitehub.local").pathname.startsWith("//")
}

function isSectionId(value: unknown): value is ConsoleSectionId {
  return typeof value === "string" && value.length > 0
}

/** The `sections` of a `console.authorize` result, or `undefined` when the result names no valid list. */
export function consoleAuthorizedSections(result: unknown): readonly ConsoleSectionId[] | undefined {
  // A section result from another JavaScript realm fails `instanceof Object`.
  if (result === null || typeof result !== "object") return
  const sectionsValue = Reflect.get(result, "sections")
  if (!Array.isArray(sectionsValue)) return
  const sections: unknown[] = sectionsValue
  if (!sections.every(isSectionId)) return
  return Object.freeze([...new Set(sections)])
}
