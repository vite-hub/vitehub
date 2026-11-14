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
const modes = new Set<ConsoleAccessMode>(["local", "open", "token"])

export const consoleOpenAccessWarning = "[vitehub] console: { auth: false } takes Console calls without a signature. Anyone who can reach /_vitehub/rpc can use the Console. Remove console.auth so the app takes only signed calls."

/** Install the Console access policy. Generated Console output calls this before it serves a request. */
export function installConsoleAccess(policy: ConsoleAccessPolicy): void {
  if (!(policy instanceof Object) || !modes.has(policy.mode)) {
    throw new TypeError("[vitehub] Console access requires a known access mode.")
  }
  if ("authorize" in policy && policy.authorize !== undefined && typeof policy.authorize !== "function") {
    throw new TypeError("[vitehub] console.authorize must default-export a function.")
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
    // Agents have no browser request and no token, so `authorize` gets a request without headers, `via: "agent"`, and
    // the user that the Actor stands for. It never sees `via: "console"` or `via: "cli"` here: those mean a verified signature.
    const request = new Request("http://vitehub.local/_vitehub/rpc", { method: "POST" })
    const result: unknown = await policy.authorize(user ? { request, user: user as ConsoleUser, via: "agent" } : { request, via: "agent" })
    if (result === true) return "all"
    return isRuntimeResponse(result) ? [] : consoleAuthorizedSections(result) ?? []
  })
}

export function installedConsoleAccessPolicy(): ConsoleAccessPolicy | undefined {
  return scope[policyKey]
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

/**
 * The `grants` of a `console.authorize` result: the page tool roles that Site access gives. `undefined` without the
 * field, and `false` when the field is not a list of role ids.
 */
export function consoleAuthorizedGrants(result: unknown): readonly string[] | undefined | false {
  if (result === null || typeof result !== "object" || !("grants" in result)) return undefined
  const value: unknown = Reflect.get(result, "grants")
  if (!Array.isArray(value)) return false
  const grants: unknown[] = value
  if (!grants.every((grant): grant is string => typeof grant === "string" && grant.length > 0)) return false
  return Object.freeze([...new Set(grants)])
}
