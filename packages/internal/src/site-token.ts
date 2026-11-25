import { decodeConsoleBase64url, encodeConsoleBase64url, isConsoleKeyName, signConsoleBytes, verifyConsoleBytes } from "./console-signature.ts"
import { internalErrorDiagnostics } from "./error-diagnostics.ts"
import { isRecord } from "./object.ts"

import type { ConsoleSigningKey } from "./console-signature.ts"

/**
 * The app route that starts a visit with `?return=<path>` and ends it with `?token=<token>`. Site access tokens let the
 * Console sign a person in to a linked app without a user in the app's database:
 *
 * 1. The app's `GET /_vitehub/site?return=/docs` sets a state cookie to a new {@link createSiteState} value and
 *    redirects to the Console's `/visit` with {@link siteVisitUrl}: the app URL, the
 *    {@link siteStateHash} of the state, the return path, and the `project` query of the request when it has one. An
 *    invite or a one-time code of the Console sends the browser to `GET /_vitehub/site` with `project`, so the visit
 *    uses the pass of that project.
 * 2. The Console checks the grant of the person: a member of the team that linked the app, or a guest that opened an
 *    invite in this browser. It asks the app with the signed {@link siteAccessOperation} call, as the member or as the
 *    guest's inviter, so `console.authorize` decides, as for every Console call. With a grant, it redirects to {@link siteTokenUrl},
 *    `<app>/_vitehub/site?token=vst1.…`, with a token from {@link signSiteToken}: the key of the link signs it, it lasts
 *    60 seconds, and it holds the hash of the state.
 * 3. The app checks the token with {@link verifySiteToken}, the public keys that it already reads with
 *    `readConsolePublicKeys()`, its URL, and its state cookie. Then it sets its own session cookie and goes to
 *    the `destination` of the match. Before the cookie ends, the app sends the browser through the Console again: while
 *    the grant exists, the Console signs a new token, and after a revoke it signs none.
 *
 * The state binds a token to the browser that started the visit, so a token that leaks, or a link that someone else
 * made, does not sign in another browser. The module uses only Web Crypto, so it runs in Node, Workers, and browsers.
 *
 * Impersonation and Content preview use the same route and the same token, with the `kind` `impersonate` or `preview`
 * and a {@link SiteTokenTarget}. A member starts them in the Console, which keeps what to open in a cookie of the Console
 * for 60 seconds and opens `GET /_vitehub/site?return=/&intent=<id>`. At `/visit`, the Console reads the intent of the
 * same browser, asks the app with the signed operation of the kind, as the member, and signs the token only when the
 * app allows it. The app keeps no state for these tokens: a token works for 60 seconds, in the browser of the state.
 */
export const siteRoute = "/_vitehub/site"

const siteTokenLifetimeSeconds = 60
const tokenVersion = "vst1"
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const maximumTokenLength = 8_192

/**
 * The app operation that tells the Console what Site access a Console member has in the app. The Console signs the call
 * as the member before each Site access action, so `console.authorize` and its `"site:read"` and `grants` limits decide.
 * The app lists it in `project.get`. The answer is a {@link SiteAccessPolicy}.
 */
export const siteAccessOperation = "site.access"

/** The answer of {@link siteAccessOperation}. */
export interface SiteAccessPolicy {
  /** The member may change Site access: open the site, make codes and invites, and revoke. `false` for `"site:read"`. */
  write: boolean
  /**
   * The page tool roles that the member gets with `console`, and the roles that the member may give a guest: the
   * `grants` of `console.authorize`, or every page tool role of the app.
   */
  roles: SiteAccessRole[]
}

/**
 * Why the Console signed the token:
 * - `site`: a member or a guest opens the site.
 * - `impersonate`: a member opens the site as another person, to see what that person sees.
 * - `preview`: a member opens a preview of the site.
 */
export type SiteTokenKind = "site" | "impersonate" | "preview"

const kinds: readonly SiteTokenKind[] = ["site", "impersonate", "preview"]

/** Whether a value is a {@link SiteTokenKind}. */
export function isSiteTokenKind(value: unknown): value is SiteTokenKind {
  return kinds.some(kind => kind === value)
}

/**
 * What an `impersonate` or `preview` token acts on, as short strings, such as `{ action: "start", userId: "u_1" }` or
 * `{ section: "content", collection: "posts", id: "hello" }`. The app reads it only from a verified token.
 */
export type SiteTokenTarget = Record<string, string>

const maximumTargetFields = 8

/**
 * The app operation that the Console calls as the member before it signs an `impersonate` or `preview` token, with its
 * input, or `undefined` for a target that the kind does not take. The app answers `{ path }`, the app path to open.
 *
 * - `impersonate` `{ action: "start", userId }`: `auth.impersonate`. `{ action: "stop" }`: `auth.stop-impersonating`.
 * - `preview` `{ section, collection, id }`: `documents.preview`.
 */
export function siteActionOperation(kind: SiteTokenKind, target: SiteTokenTarget): { operation: string, input: Record<string, string> } | undefined {
  const names = Object.keys(target).sort().join(",")
  if (kind === "impersonate" && target.action === "start" && target.userId && names === "action,userId") return { operation: "auth.impersonate", input: { userId: target.userId } }
  if (kind === "impersonate" && target.action === "stop" && names === "action") return { operation: "auth.stop-impersonating", input: {} }
  if (kind === "preview" && target.section && target.collection && target.id && names === "collection,id,section") return { operation: "documents.preview", input: { collection: target.collection, id: target.id, section: target.section } }
  return undefined
}

/** Read an untrusted target, such as the target of a Console intent, or `undefined` when it is not a {@link SiteTokenTarget}. */
export function readSiteTokenTarget(value: unknown): SiteTokenTarget | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length > maximumTargetFields) return undefined
  const target: SiteTokenTarget = {}
  for (const [name, field] of entries) {
    if (!/^[A-Za-z]\w{0,31}$/.test(name) || typeof field !== "string" || !field || field.length > 512) return undefined
    target[name] = field
  }
  return target
}

/** The person and the roles that a token signs in. */
export interface SiteTokenClaims {
  /** The URL of the app, its origin and base path without a trailing `/`, such as `https://app.example.com/portal`. */
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
  /** What an `impersonate` or `preview` token acts on. A `site` token has none. */
  target?: SiteTokenTarget
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
  | "SITE_TOKEN_PATH"
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
  /** The URL of `claims.path` below the app URL, where the app sends the browser. */
  destination: string
}

/** A role that Site access gives, such as `comments-write`. `membersOnly` roles never go to guests. */
export interface SiteAccessRole {
  id: string
  label: string
  description?: string
  membersOnly?: true
}

/** Read an untrusted {@link siteAccessOperation} answer, or `undefined` when it is not a {@link SiteAccessPolicy}. */
export function readSiteAccessPolicy(value: unknown): SiteAccessPolicy | undefined {
  if (!isRecord(value) || typeof value.write !== "boolean" || !Array.isArray(value.roles)) return undefined
  const roles: SiteAccessRole[] = []
  for (const role of value.roles) {
    if (!isRecord(role) || typeof role.id !== "string" || !/^[\w:-]{1,64}$/.test(role.id) || typeof role.label !== "string" || !role.label) return undefined
    roles.push({ id: role.id, label: role.label, ...(typeof role.description === "string" && role.description ? { description: role.description } : {}), ...(role.membersOnly === true ? { membersOnly: true } : {}) })
  }
  return { write: value.write, roles }
}

/**
 * The roles that Site access knows. Members of the Console team get `console` and the roles of the app's
 * {@link SiteAccessPolicy}. Guests get the roles of their invite, never `console`. The `comments-` roles are the ones
 * that `commentsRoleAllows()` of `@vite-hub/comments` checks.
 */
export const siteAccessRoles: readonly SiteAccessRole[] = [
  { id: "console", label: "Console", description: "Open the app in the ViteHub Console. Members only.", membersOnly: true },
  { id: "comments-read", label: "Read comments", description: "See the comments on every page." },
  { id: "comments-write", label: "Write comments", description: "Start threads and reply." },
  { id: "comments-resolve", label: "Resolve threads", description: "Resolve and reopen threads." },
  { id: "comments-delete", label: "Delete comments", description: "Delete threads and messages." },
]

/** A new random state for the app's state cookie, 32 bytes as base64url. */
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

/** A new random id of a Console intent, 32 bytes as base64url, which the visit carries as `intent`. */
export function createSiteIntent(): string {
  return encodeConsoleBase64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** Whether a value has the form of a {@link createSiteIntent} id. */
export function isSiteIntent(value: string): boolean {
  return /^[\w-]{43}$/.test(value)
}

/**
 * Whether a value is a path of the app, such as `/docs?tab=1`: it starts with one `/`, and has no `\` and no control
 * character, which URL parsers remove.
 */
export function isSitePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !/\p{Cc}/u.test(value) && value.length <= 2_048
}

function appUrl(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

function siteAppUrl(value: string): string | undefined {
  return URL.canParse(value) ? appUrl(new URL(value)) : undefined
}

function siteDestination(app: string, path: string): string | undefined {
  if (!isSitePath(path)) return undefined
  const base = new URL(app)
  const mount = base.pathname.replace(/\/+$/, "")
  const url = new URL(`${mount}${path}`, base.origin)
  return url.origin === base.origin && (url.pathname === mount || url.pathname.startsWith(`${mount}/`)) ? url.href : undefined
}

/** The app URL that ends a visit: `<app URL>/_vitehub/site?token=<token>`. `app` may have a base path, such as `/portal`. */
export function siteTokenUrl(app: string, token: string): string {
  return `${app.replace(/\/+$/, "")}${siteRoute}?token=${encodeURIComponent(token)}`
}

/**
 * The Console URL that starts a visit, from the app's `GET /_vitehub/site`, with the `project` and `intent` queries of
 * that request. An `intent` names the impersonation or preview that the member started in the Console.
 */
export function siteVisitUrl(input: { console: string, app: string, state: string, path: string, project?: string, intent?: string }): string {
  const query = new URLSearchParams({ app: input.app, state: input.state, return: input.path, ...(input.project ? { project: input.project } : {}) })
  if (input.intent) query.set("intent", input.intent)
  return `${input.console.replace(/\/+$/, "")}/visit?${query}`
}

function siteHandoffBytes(app: string, issuer: string, project: string, path: string, key: string, expires: string) {
  return encoder.encode(JSON.stringify(["vitehub-site-handoff-v1", app, issuer, project, path, key, expires]))
}

function isSiteIssuer(issuer: string): boolean {
  const url = URL.parse(issuer)
  return url !== null && url.origin === issuer && (url.protocol === "https:"
    || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
}

export async function signSiteHandoff(input: { app: string, issuer: string, project: string, path: string, key: ConsoleSigningKey }): Promise<string | undefined> {
  if (!isSiteIssuer(input.issuer)) return undefined
  const expires = String(Math.floor(Date.now() / 1_000) + siteTokenLifetimeSeconds)
  const { app, issuer, project, path, key } = input
  const signature = await signConsoleBytes(key, siteHandoffBytes(app, issuer, project, path, key.name, expires))
  const query = new URLSearchParams({ return: path, project, issuer, handoff: `${key.name}.${expires}.${signature}` })
  return `${app}${siteRoute}?${query}`
}

export async function verifySiteHandoff(input: { app: string, issuer: string, project: string, path: string, handoff: string, keys: ReadonlyMap<string, Uint8Array<ArrayBuffer>> }): Promise<boolean> {
  const { app, issuer, project, path, handoff, keys } = input
  if (!isSiteIssuer(issuer)) return false
  const match = /^([A-Z0-9_]{1,64})\.(\d{1,12})\.([\w-]{86})$/.exec(handoff)
  if (!match || match[0] !== handoff) return false
  const [, key, expires, signature] = match
  if (!key || !expires || !signature) return false
  const remaining = Number(expires) - Math.floor(Date.now() / 1_000)
  const publicKey = keys.get(key)
  return publicKey !== undefined && remaining > 0 && remaining <= siteTokenLifetimeSeconds
    && await verifyConsoleBytes(publicKey, signature, siteHandoffBytes(app, issuer, project, path, key, expires))
}

/**
 * Sign a token with the private key of a link: `vst1.<key name>.<claims as base64url JSON>.<Ed25519 signature>`. The
 * signature covers `vst1.<key name>.<claims>`. `claims.state` is the hash that the app sent, not the state. It throws
 * `INTERNAL_SITE_TOKEN_TOO_LONG` for a token longer than {@link verifySiteToken} accepts, such as one with a long path.
 */
export async function signSiteToken(input: { key: ConsoleSigningKey, claims: Omit<SiteTokenClaims, "iat" | "exp">, now?: number }): Promise<string> {
  const iat = Math.floor((input.now ?? Date.now()) / 1_000)
  const claims: SiteTokenClaims = { ...input.claims, aud: appUrl(new URL(input.claims.aud)), iat, exp: iat + siteTokenLifetimeSeconds }
  const signed = `${tokenVersion}.${input.key.name}.${encodeConsoleBase64url(encoder.encode(JSON.stringify(claims)))}`
  const token = `${signed}.${await signConsoleBytes(input.key, encoder.encode(signed))}`
  if (token.length > maximumTokenLength) throw internalErrorDiagnostics.INTERNAL_SITE_TOKEN_TOO_LONG({ length: token.length, maximum: maximumTokenLength })
  return token
}

function failure(code: SiteTokenCode, message: string): SiteTokenFailure {
  return { code, message, ok: false }
}

function readClaims(value: unknown): SiteTokenClaims | undefined {
  if (!isRecord(value)) return undefined
  const { aud, email, exp, iat, image, kind, name, path, roles, state, sub, target } = value
  const text = (field: unknown, maximum = 512): field is string => typeof field === "string" && field.length > 0 && field.length <= maximum
  const optional = (field: unknown) => field === undefined || text(field, 2_048)
  const time = (field: unknown): field is number => typeof field === "number" && Number.isSafeInteger(field)
  if (!text(aud, maximumTokenLength) || !text(sub) || !text(name) || !text(path, 2_048) || !text(state) || !text(kind) || !time(iat) || !time(exp)) return undefined
  if (!optional(email) || !optional(image) || !Array.isArray(roles) || !roles.every(role => text(role, 64))) return undefined
  const targetClaim = target === undefined ? undefined : readSiteTokenTarget(target)
  if (target !== undefined && !targetClaim) return undefined
  return {
    aud,
    sub,
    name,
    ...(typeof email === "string" ? { email } : {}),
    ...(typeof image === "string" ? { image } : {}),
    roles: roles.filter(role => typeof role === "string"),
    // SAFETY: verifySiteToken() checks the kind against the kinds that the app accepts.
    kind: kind as SiteTokenKind,
    ...(targetClaim ? { target: targetClaim } : {}),
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
 * Check a token in the app. `keys` are the public keys of `readConsolePublicKeys()`, `origin` is the URL that the app
 * serves, with its base path, such as `https://app.example.com/portal`, and `state` is the value of its
 * state cookie. `kinds` are the kinds that the route accepts, `["site"]` by default. `lifetime` is the number of
 * seconds after `iat` that the token works, for an app that keeps the token in its session cookie. Without it, the
 * token works until its `exp`, 60 seconds. The token is refused when it is malformed, signed with an unknown key or
 * another key, made for another origin, expired, made for another browser, of another kind, or when its path resolves
 * outside the app URL.
 */
export async function verifySiteToken(input: { token: string, keys: ReadonlyMap<string, Uint8Array<ArrayBuffer>>, origin: string, state: string, kinds?: readonly SiteTokenKind[], lifetime?: number, now?: number }): Promise<SiteTokenMatch | SiteTokenFailure> {
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
  const app = siteAppUrl(input.origin)
  if (siteAppUrl(claims.aud) !== app) return failure("SITE_TOKEN_AUDIENCE", `The Site access token was made for ${claims.aud}, and this app is ${app}.`)
  const now = Math.floor((input.now ?? Date.now()) / 1_000)
  const end = input.lifetime === undefined ? claims.exp : claims.iat + input.lifetime
  if (now >= end || claims.iat > now + siteTokenLifetimeSeconds) return failure("SITE_TOKEN_EXPIRED", "The Site access token expired. Open the site from the Console again.")
  if (!input.state || claims.state !== await siteStateHash(input.state)) {
    return failure("SITE_TOKEN_STATE", "The Site access token was made for another browser. Open the site again in this browser.")
  }
  if (!(input.kinds ?? ["site"]).includes(claims.kind)) return failure("SITE_TOKEN_KIND", `This route does not accept a \`${claims.kind}\` token.`)
  const destination = siteDestination(input.origin, claims.path)
  if (!destination) return failure("SITE_TOKEN_PATH", "The path of the Site access token is not a page of this app.")
  return { claims, destination, key: name, ok: true }
}
