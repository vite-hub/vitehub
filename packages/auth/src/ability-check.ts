import { authErrorDiagnostics } from "./error-diagnostics.ts"

/** Why a rule refused: the HTTP status, and the code and details for the page. */
export interface AbilityCheckRefusal {
  status: number
  code?: string
  details?: unknown
}

type CheckedRule = ((user: object | null, ...args: unknown[]) => unknown) & { guest?: true }

const signedOut: AbilityCheckRefusal = Object.freeze({ status: 401, code: "signed-out" })

/** Finds a rule by name, or fails with `AUTH_R0020`. */
export function findAbilityRule(rules: object, name: string): CheckedRule {
  const rule: unknown = Object.prototype.hasOwnProperty.call(rules, name) ? Reflect.get(rules, name) : undefined
  if (typeof rule !== "function") {
    throw authErrorDiagnostics.AUTH_R0020({ message: `[vitehub] There is no ability named ${JSON.stringify(name)}. Add it to shared/abilities.ts with defineAbilities().` })
  }
  // SAFETY: `defineAbilities()` types every rule as `(user, ...args) => verdict`; `guest()` adds the `guest` mark.
  return rule as CheckedRule
}

/**
 * Asks a rule about a user. Returns `null` when the rule allows, or the refusal. A signed-out user gets `401` unless the
 * rule is open to guests. A rule that throws throws here too.
 */
export function checkAbility(rules: object, user: object | null, name: string, args: unknown[]): AbilityCheckRefusal | null {
  const rule = findAbilityRule(rules, name)
  if (!user && rule.guest !== true) return signedOut
  return toRefusal(rule(user, ...args), name)
}

function toRefusal(verdict: unknown, name: string): AbilityCheckRefusal | null {
  if (verdict === true) return null
  if (typeof verdict === "string") return { status: 403, code: verdict }
  if (typeof verdict === "object" && verdict !== null) {
    if (Symbol.for("vitehub.auth.denial") in verdict) {
      const { code, details, status } = verdict as { code: string, details: unknown, status: number }
      return { status, code, details }
    }
    if (typeof Reflect.get(verdict, "then") === "function") {
      throw authErrorDiagnostics.AUTH_R0021({ message: `[vitehub] The ability ${JSON.stringify(name)} returned a Promise. Rules also run in the browser, so they must return at once. Load the data first and pass it to the rule.` })
    }
  }
  // `false`, and any other value, such as a missing `return`, refuses.
  return { status: 403 }
}
