import { decodeConsoleBase64url, encodeConsoleBase64url, isConsoleKeyName, signConsoleBytes, verifyConsoleBytes } from "./console-signature.ts"
import { isRecord } from "./object.ts"

import type { ConsoleSigningKey } from "./console-signature.ts"

/**
 * The app route that starts a visit with `?return=<path>` and ends it with `?token=<token>`. Site access tokens let the
 * Console sign a person in to a linked app without a user in the app's database:
 *
 * 1. The app's `GET /_vitehub/site?return=/docs` sets the {@link siteStateCookie} to a new {@link createSiteState} value
 *    and redirects to the Console's {@link siteVisitPath} with the app URL, the {@link siteStateHash} of the state, and
 *    the return path.
 * 2. The Console checks the grant of the person: a member of the team that linked the app, or a guest that opened an
 *    invite in this browser. With a grant, it redirects to {@link siteTokenUrl}, `<app>/_vitehub/site?token=vst1.…`,
 *    with a token from {@link signSiteToken}: the key of the link signs it, it lasts 60 seconds, and it holds the hash of
 *    the state.
 * 3. The app checks the token with {@link verifySiteToken}, the public keys that it already reads with
 *    `readConsolePublicKeys()`, its origin, and its state cookie. Then it sets {@link siteCookie} for 12 hours and goes
 *    to the return path. Before the cookie ends, the app sends the browser through the Console again: while the grant
 *    exists, the Console signs a new token, and after a revoke it signs none.
 *
 * The state binds a token to the browser that started the visit, so a token that leaks, or a link that someone else
 * made, does not sign in another browser. The module uses only Web Crypto, so it runs in Node, Workers, and browsers.
 */
export const siteRoute = "/_vitehub/site"
/** The Console route that the app sends a visit to: `?app=<app URL>&state=<state hash>&return=<path>`. */
export const siteVisitPath = "/visit"
/** The cookie of the app that holds the state of one visit until the token comes back. */
export const siteStateCookie = "__Host-vitehub-site-state"
/** The cookie of the app that holds the person that a token signed in. */
export const siteCookie = "__Host-vitehub-site"
/** A token is good for this many seconds after the Console signs it. */
export const siteTokenLifetimeSeconds = 60
/** The app keeps the person of a token for this many seconds. Then it asks the Console again. */
export const siteSessionLifetimeSeconds = 12 * 60 * 60

const tokenVersion = "vst1"
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const maximumTokenLength = 8_192

/**
 * Why the Console signed the token:
 * - `site`: a member or a guest opens the site.
 * - `impersonate`: a member opens the site as another person, to see what that person sees.
 * - `preview`: a member opens a preview of the site.
 */
export type SiteTokenKind = "site" | "impersonate" | "preview"

const kinds: readonly SiteTokenKind[] = ["site", "impersonate", "preview"]

/** The person and the roles that a token signs in. */
export interface SiteTokenClaims {
  /** The origin of the app, such as `https://app.example.com`. */
  aud: string
  /** The id of the person in the Console: the user id of a member, or the grant id of a guest. */
  sub: string
  /** The name that the app shows, such as the author of a comment. */
  name: string
  /** The email of a member. Guests have none. */
  email?: string
  /** The image of a member. */
  image?: string
  /** The roles of the person, such as `console` and `comments-write`. */
  roles: string[]
  kind: SiteTokenKind
  /** The path of the app to open after the sign-in, such as `/docs`. */
  path: string
  /** The {@link siteStateHash} of the state cookie of the browser that started the visit. */
  state: string
  /** Seconds since the epoch. */
  iat: number
  /** Seconds since the epoch. */
  exp: number
}

/** The codes of a refused token. */
export type SiteTokenCode =
  | "SITE_TOKEN_AUDIENCE"
  | "SITE_TOKEN_EXPIRED"
  | "SITE_TOKEN_KEY_UNKNOWN"
  | "SITE_TOKEN_KIND"
  | "SITE_TOKEN_MALFORMED"
  | "SITE_TOKEN_SIGNATURE"
  | "SITE_TOKEN_STATE"

export interface SiteTokenFailure {
  ok: false
  code: SiteTokenCode
  message: string
}

export interface SiteTokenMatch {
  ok: true
  claims: SiteTokenClaims
  /** The `<NAME>` of the `VITEHUB_CONSOLE_KEY_<NAME>` that matched. */
  key: string
}

/** A role that Site access gives, such as `comments-write`. `membersOnly` roles never go to guests. */
export interface SiteAccessRole {
  id: string
  label: string
  description: string
  membersOnly?: true
}

/**
 * The roles that Site access gives. Members of the Console team get all of them. Guests get the roles of their invite,
 * never `console`. The `comments-` roles are the ones that `commentsRoleAllows()` of `@vite-hub/comments` checks.
 */
export const siteAccessRoles: readonly SiteAccessRole[] = [
  { id: "console", label: "Console", description: "Open the app in the ViteHub Console. Members only.", membersOnly: true },
  { id: "comments-read", label: "Read comments", description: "See the comments on every page." },
  { id: "comments-write", label: "Write comments", description: "Start threads and reply." },
  { id: "comments-resolve", label: "Resolve threads", description: "Resolve and reopen threads." },
  { id: "comments-delete", label: "Delete comments", description: "Delete threads and messages." },
]

/** A new random state for the {@link siteStateCookie}, 32 bytes as base64url. */
export function createSiteState(): string {
  return encodeConsoleBase64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** The SHA-256 of a state, base64url: 43 characters. Only the hash leaves the app. */
export async function siteStateHash(state: string): Promise<string> {
  return encodeConsoleBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(state))))
}

/** Whether a value has the form of a {@link siteStateHash}. */
export function isSiteStateHash(value: string): boolean {
  return /^[\w-]{43}$/.test(value)
}

/** Whether a value is a path of the app, such as `/docs?tab=1`: it starts with one `/` and has no `\`. */
export function isSitePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && value.length <= 2_048
}

/** The app URL that ends a visit: `<app URL>/_vitehub/site?token=<token>`. `app` may have a base path, such as `/portal`. */
export function siteTokenUrl(app: string, token: string): string {
  return `${app.replace(/\/+$/, "")}${siteRoute}?token=${encodeURIComponent(token)}`
}

/** The Console URL that starts a visit, from the app's `GET /_vitehub/site`. */
export function siteVisitUrl(input: { console: string, app: string, state: string, path: string }): string {
  const query = new URLSearchParams({ app: input.app, state: input.state, return: input.path })
  return `${input.console.replace(/\/+$/, "")}${siteVisitPath}?${query}`
}

/**
 * Sign a token with the private key of a link: `vst1.<key name>.<claims as base64url JSON>.<Ed25519 signature>`. The
 * signature covers `vst1.<key name>.<claims>`. `claims.state` is the hash that the app sent, not the state.
 */
export async function signSiteToken(input: { key: ConsoleSigningKey, claims: Omit<SiteTokenClaims, "iat" | "exp">, now?: number }): Promise<string> {
  const iat = Math.floor((input.now ?? Date.now()) / 1_000)
  const claims: SiteTokenClaims = { ...input.claims, aud: new URL(input.claims.aud).origin, iat, exp: iat + siteTokenLifetimeSeconds }
  const signed = `${tokenVersion}.${input.key.name}.${encodeConsoleBase64url(encoder.encode(JSON.stringify(claims)))}`
  return `${signed}.${await signConsoleBytes(input.key, encoder.encode(signed))}`
}

function failure(code: SiteTokenCode, message: string): SiteTokenFailure {
  return { code, message, ok: false }
}

function readClaims(value: unknown): SiteTokenClaims | undefined {
  if (!isRecord(value)) return undefined
  const { aud, email, exp, iat, image, kind, name, path, roles, state, sub } = value
  const text = (field: unknown, maximum = 512): field is string => typeof field === "string" && field.length > 0 && field.length <= maximum
  const optional = (field: unknown) => field === undefined || text(field, 2_048)
  const time = (field: unknown): field is number => typeof field === "number" && Number.isSafeInteger(field)
  if (!text(aud) || !text(sub) || !text(name) || !text(path, 2_048) || !text(state) || !text(kind) || !time(iat) || !time(exp)) return undefined
  if (!optional(email) || !optional(image) || !Array.isArray(roles) || !roles.every(role => text(role, 64))) return undefined
  return {
    aud,
    sub,
    name,
    ...(typeof email === "string" ? { email } : {}),
    ...(typeof image === "string" ? { image } : {}),
    roles: roles.filter(role => typeof role === "string"),
    // SAFETY: verifySiteToken() checks the kind against the kinds that the app accepts.
    kind: kind as SiteTokenKind,
    path,
    state,
    iat,
    exp,
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes))
  }
  catch {
    return undefined
  }
}

/**
 * Check a token in the app. `keys` are the public keys of `readConsolePublicKeys()`, `origin` is the origin that the
 * app serves, and `state` is the value of its {@link siteStateCookie}. `kinds` are the kinds that the route accepts,
 * `["site"]` by default. The token is refused when it is malformed, signed with an unknown key or another key, made for
 * another origin, expired, made for another browser, or of another kind.
 */
export async function verifySiteToken(input: { token: string, keys: ReadonlyMap<string, Uint8Array<ArrayBuffer>>, origin: string, state: string, kinds?: readonly SiteTokenKind[], now?: number }): Promise<SiteTokenMatch | SiteTokenFailure> {
  const parts = input.token.length <= maximumTokenLength ? input.token.split(".") : []
  const [version, name, payload, signature] = parts
  const bytes = parts.length === 4 && version === tokenVersion && payload ? decodeConsoleBase64url(payload) : undefined
  const claims = bytes ? readClaims(parseJson(bytes)) : undefined
  if (!name || !isConsoleKeyName(name) || !signature || !claims || !kinds.includes(claims.kind)) {
    return failure("SITE_TOKEN_MALFORMED", "The Site access token is malformed. Open the site from the Console again.")
  }
  const publicKey = input.keys.get(name)
  if (!publicKey) return failure("SITE_TOKEN_KEY_UNKNOWN", `The Site access token was signed with the key \`${name}\`, and this app has no \`VITEHUB_CONSOLE_KEY_${name}\`.`)
  if (!await verifyConsoleBytes(publicKey, signature, encoder.encode(`${version}.${name}.${payload}`))) {
    return failure("SITE_TOKEN_SIGNATURE", `The Site access token does not match the key \`VITEHUB_CONSOLE_KEY_${name}\`.`)
  }
  const origin = new URL(input.origin).origin
  if (claims.aud !== origin) return failure("SITE_TOKEN_AUDIENCE", `The Site access token was made for ${claims.aud}, and this app is ${origin}.`)
  const now = Math.floor((input.now ?? Date.now()) / 1_000)
  if (now >= claims.exp || claims.iat > now + siteTokenLifetimeSeconds) return failure("SITE_TOKEN_EXPIRED", "The Site access token expired. Open the site from the Console again.")
  if (!input.state || claims.state !== await siteStateHash(input.state)) {
    return failure("SITE_TOKEN_STATE", "The Site access token was made for another browser. Open the site again in this browser.")
  }
  if (!(input.kinds ?? ["site"]).includes(claims.kind)) return failure("SITE_TOKEN_KIND", `This route does not accept a \`${claims.kind}\` token.`)
  return { claims, key: name, ok: true }
}
