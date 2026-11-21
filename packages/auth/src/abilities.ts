import type { AuthAnonymousAuthorization, AuthAuthorization, RegisteredAuth } from "./types.ts"

/** A 4xx status that a rule can refuse with. `403` is the default. */
export type AbilityStatus = 400 | 401 | 402 | 403 | 404 | 405 | 409 | 410 | 422 | 423 | 429 | 451

declare const abilityDenial: unique symbol

/** A refusal that `deny()` made: its code, its details, and the HTTP status of the server error. */
export interface AbilityDenial<Code extends string = string, Details = unknown> {
  readonly [abilityDenial]: true
  readonly code: Code
  readonly details: Details
  readonly status: AbilityStatus
}

/** What a rule returns. Only `true` allows. `false`, a code, or `deny()` refuse. */
export type AbilityVerdict = boolean | string | AbilityDenial

/** The signed-in user that a rule receives, typed from the app's Auth Definition. */
export type AbilityUser = RegisteredAuth["$Infer"]["Session"]["user"]

/**
 * A rule: the signed-in user, then the arguments it is about. Rules run on the server and in the browser, so they are
 * synchronous. Load the data first and pass it in. Method syntax makes the parameters bivariant, so each rule can type
 * its own arguments.
 */
export type AbilityRule = { rule(user: AbilityUser, ...args: unknown[]): AbilityVerdict }["rule"]

/** The rules of an app, by name. */
export type AbilityRules = Record<string, AbilityRule>

/** A rule that `guest()` opened to signed-out visitors. */
export type GuestAbilityRule<Args extends unknown[] = unknown[], Verdict extends AbilityVerdict = AbilityVerdict> =
  ((user: AbilityUser | null, ...args: Args) => Verdict) & { readonly guest: true }

/**
 * Defines the app's rules in `shared/abilities.ts`. The server and the app run the same rules.
 *
 * @example
 * export default defineAbilities({
 *   "posts.edit": (user, post: Post) => user.id === post.authorId || deny("not-author"),
 * })
 */
export function defineAbilities<const Rules extends AbilityRules>(rules: Rules): Rules {
  return rules
}

/**
 * Refuses with a code, and optionally a status other than `403` and details for the page.
 * A rule that needs neither can return the code string, or `false`.
 *
 * @example
 * deny("not-author")
 * deny("plan-limit", { status: 402, details: { limit: 3 } })
 */
export function deny<const Code extends string, const Details = undefined>(
  code: Code,
  options: { status?: AbilityStatus, details?: Details } = {},
): AbilityDenial<Code, Details> {
  // A registered symbol, so the server bundle and the browser bundle recognize the same refusal.
  const denial = { [Symbol.for("vitehub.auth.denial")]: true, code, details: options.details, status: options.status ?? 403 }
  // SAFETY: the registered symbol marks the object at runtime. The declared brand only exists in the types.
  return Object.freeze(denial) as unknown as AbilityDenial<Code, Details>
}

/**
 * Opens a rule to signed-out visitors: `user` is `null` for them. Without `guest()`, a signed-out visitor gets `401`
 * before the rule runs.
 *
 * @example
 * "posts.read": guest((user, post: Post) => post.published || user?.id === post.authorId),
 */
export function guest<Args extends unknown[], Verdict extends AbilityVerdict>(
  rule: (user: AbilityUser | null, ...args: Args) => Verdict,
): GuestAbilityRule<Args, Verdict> {
  const open = (user: AbilityUser | null, ...args: Args): Verdict => rule(user, ...args)
  Object.defineProperty(open, "guest", { value: true })
  // SAFETY: `guest` was defined on the function above.
  return open as GuestAbilityRule<Args, Verdict>
}

type RegisteredAbilities = ViteHub.AuthRegistry extends { abilities: infer Rules } ? Rules : Record<never, never>

/** The name of a rule in the app's `shared/abilities.ts`. */
export type AbilityName = keyof RegisteredAbilities & string

/** What a rule takes after the user. */
export type AbilityArgs<Name extends string> = Name extends keyof RegisteredAbilities
  ? RegisteredAbilities[Name] extends (user: never, ...args: infer Args) => unknown ? Args : never
  : never

type RefusalOf<Verdict> = Verdict extends false ? { code: undefined, details: undefined }
  : Verdict extends AbilityDenial<infer Code, infer Details> ? { code: Code, details: Details }
    : Verdict extends string ? { code: Verdict, details: undefined }
      : never

/**
 * Each way a rule can refuse, as `<AuthPermission>` passes it to the `#denied` slot and the server error puts it in `data`.
 * A signed-out visitor gets `signed-out` from every rule that is not open to guests.
 *
 * @example
 * AbilityRefusal<"posts.edit">  // { code: "not-author", details: undefined } | { code: "signed-out", details: undefined }
 */
export type AbilityRefusal<Name extends string = AbilityName> =
  | (Name extends keyof RegisteredAbilities
    ? RegisteredAbilities[Name] extends (...args: never[]) => infer Verdict ? RefusalOf<Exclude<Verdict, true>> : never
    : never)
  | { code: "signed-out", details: undefined }

/** The checked request, session, and user that `requireAbility()` returns. A guest rule can return a signed-out caller. */
export type AbilityAuthorization<Name extends string> = Name extends keyof RegisteredAbilities
  ? RegisteredAbilities[Name] extends { guest: true } ? AuthAuthorization | AuthAnonymousAuthorization : AuthAuthorization
  : AuthAuthorization
