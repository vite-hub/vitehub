import { importSealKey, sealWithKey, unsealWithKey } from "@vite-hub/env/seal"
import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"
import { userAgentDevice } from "@vite-hub/internal/runtime/user-agent"
import { deriveViteHubSecret, readViteHubSecret } from "@vite-hub/internal/secret"

import { consoleRequestError, isConsoleDevelopmentRuntime } from "./request.ts"
import { getConsoleSections } from "./sections.ts"

import type { SealKey } from "@vite-hub/env/seal"
import type { ViteHubSiteVisitor } from "@vite-hub/internal/runtime/page-tools"
import type { KVDriversWith } from "@vite-hub/kv"
import type { SiteSession } from "../site-access.ts"

/**
 * Site access for an app without ViteHub Auth. Redeeming a `page.member` or `page.guest` ticket sets the `vitehub_site`
 * cookie: the person and their roles, sealed with AES-GCM under a key that `VITEHUB_SECRET` gives for this purpose
 * alone, as Comments seals its GitHub sign-in. The cookie is HttpOnly and lasts 7 days, as a Better Auth session does.
 *
 * The cookie trusts the ticket: a signed Console call made it, so the person and the roles are as trusted as the
 * Console key. The browser cannot read or change the cookie. Each cookie also names a session in the app's KV store,
 * and a cookie whose session is gone is ignored, so `site.revoke-session` signs the browser out.
 *
 * Tickets and sessions need a KV store that every instance of the app shares, and tickets need `getAndDelete()`, so a
 * link works once also when two instances redeem it at the same time. A development server keeps both in memory.
 */

/** The cookie of a browser that Site access signed in, in an app without Auth. */
export const consoleSiteCookie: string = "vitehub_site"
/** Seconds that the browser stays signed in, as Better Auth's default session. */
export const consoleSiteLifetime: number = 7 * 24 * 60 * 60
const sessionPrefix = "vitehub-site-session:"
const keyPurpose = "vitehub:site:session"
const encoder = new TextEncoder()

/** The part of a ViteHub KV store that Site access uses. Each call returns `[error, value]`, as `@vite-hub/kv` does. */
export interface ConsoleSiteKV {
  set: (key: string, value: string, options: { ttl: number }) => Promise<readonly [unknown, unknown]>
  get: (key: string, options: { type: "text" }) => Promise<readonly [unknown, string | null | undefined]>
  getAndDelete: (key: string, options: { type: "text" }) => Promise<readonly [unknown, string | null | undefined]>
  keys: (base: string) => Promise<readonly [unknown, string[] | undefined]>
  delete: (key: string) => Promise<readonly [unknown, unknown]>
}

function unwrap<T>([error, value]: readonly [unknown, T]): T {
  if (error) throw error
  return value
}

/** The keys of a KV store below a prefix. Some drivers list keys with `/` where the key had `:`. */
export async function consoleSiteKeys(kv: ConsoleSiteKV, prefix: string): Promise<string[]> {
  const keys = unwrap(await kv.keys(prefix.replace(/:$/, ""))) ?? []
  return keys.map(key => key.replaceAll("/", ":")).filter(key => key.startsWith(prefix))
}

const memoryKey: unique symbol = Symbol.for("vitehub.console.tickets")
// SAFETY: This module owns the process slot, so separately bundled Console chunks share one store.
const memoryScope = globalThis as typeof globalThis & { [memoryKey]?: Map<string, { value: string, expiresAt: number }> }

/** Keys in the memory of this process. Only a development server uses it: another instance would not see them. */
function memorySiteKV(): ConsoleSiteKV {
  const entries = memoryScope[memoryKey] ??= new Map()
  const live = (key: string) => {
    const entry = entries.get(key)
    if (entry && entry.expiresAt <= Date.now()) entries.delete(key)
    return entry && entry.expiresAt > Date.now() ? entry.value : null
  }
  return {
    async set(key, value, { ttl }) {
      for (const [name, entry] of entries) if (entry.expiresAt <= Date.now()) entries.delete(name)
      entries.set(key, { value, expiresAt: Date.now() + ttl * 1000 })
      return [undefined, undefined]
    },
    async get(key) {
      return [undefined, live(key)]
    },
    async getAndDelete(key) {
      const value = live(key)
      entries.delete(key)
      return [undefined, value]
    },
    async keys(base) {
      return [undefined, [...entries.keys()].filter(key => key.startsWith(base) && live(key) !== null)]
    },
    async delete(key) {
      entries.delete(key)
      return [undefined, undefined]
    },
  }
}

/** Drivers whose `getAndDelete()` is atomic, so a one-time link works once across instances. */
const atomicDrivers: readonly string[] = ["database", "redis", "upstash"] satisfies readonly KVDriversWith<"getAndDelete">[]

let installedKV: ConsoleSiteKV | undefined

/** Replace the KV store of tickets and site sessions, or restore the default with `undefined`. Tests use it. */
export function setConsoleSiteKV(kv: ConsoleSiteKV | undefined): void {
  installedKV = kv
}

function storeMissing(why: string): Error {
  return consoleRequestError(500, `One-time links need a store that every instance of the app shares. ${why}`, "CONSOLE_TICKET_STORE_MISSING")
}

/**
 * The KV store of tickets without Auth, and of site sessions: the app's default KV store when its driver takes a key
 * out atomically. A development server keeps them in memory. Otherwise it fails closed with
 * `CONSOLE_TICKET_STORE_MISSING`.
 */
export async function consoleSiteKV(): Promise<ConsoleSiteKV> {
  if (installedKV) return installedKV
  if (isConsoleDevelopmentRuntime()) return memorySiteKV()
  // Generated Console sections reflect the app's KV integration.
  if (!getConsoleSections().includes("kv")) throw storeMissing("The app has no Auth Database and no KV store.")
  const { getKVStoreDriver, kv } = await import("@vite-hub/kv")
  const driver = await getKVStoreDriver()
  if (!atomicDrivers.includes(driver)) throw storeMissing(`The default KV store uses the ${driver} driver, which cannot take a link out once when two instances ask at the same time.`)
  return kv
}

function serverEnv(name: string): string | undefined {
  const value: unknown = getActiveCloudflareBinding<unknown>(name) ?? globalThis.process?.env?.[name]
  return typeof value === "string" && value ? value : undefined
}

const keyCache: { root?: string, key?: Promise<SealKey> } = {}
const developmentSlot: unique symbol = Symbol.for("vitehub.console.site-key")
// SAFETY: This module owns the process slot, so separately bundled Console chunks share one development key.
const developmentScope = globalThis as typeof globalThis & { [developmentSlot]?: Promise<SealKey> }

/**
 * The key of the cookie: derived from `VITEHUB_SECRET` for Site access alone, so the app's other cookies and this one
 * never open each other. A development server without the secret uses a random key of this process. In production,
 * the key is undefined without the secret, and a short secret throws, as for Comments.
 */
async function siteKey(): Promise<SealKey | undefined> {
  const root = readViteHubSecret({ VITEHUB_SECRET: serverEnv("VITEHUB_SECRET") })
  if (!root) {
    if (!isConsoleDevelopmentRuntime()) return undefined
    return await (developmentScope[developmentSlot] ??= importSealKey(crypto.getRandomValues(new Uint8Array(32))))
  }
  if (keyCache.root !== root || !keyCache.key) {
    keyCache.root = root
    keyCache.key = deriveViteHubSecret(root, keyPurpose).then(hex => importSealKey(Uint8Array.from(hex.match(/../g)!, byte => Number.parseInt(byte, 16))))
  }
  return await keyCache.key
}

/** The key of the cookie, or `CONSOLE_SITE_SECRET_MISSING` before a ticket is made or redeemed. */
export async function requireConsoleSiteKey(): Promise<SealKey> {
  const key = await siteKey()
  if (!key) throw consoleRequestError(500, "Site access without Auth seals the browser's cookie with VITEHUB_SECRET, and the app has none.", "CONSOLE_SITE_SECRET_MISSING")
  return key
}

/** A browser that Site access signed in. The KV store keeps it, so revoking it signs the browser out. */
interface SiteRecord {
  id: string
  kind: "member" | "guest"
  person: { id: string, name: string, email?: string, image?: string }
  roles: string[]
  device: string
  /** Milliseconds since the epoch. */
  createdAt: number
  expiresAt: number
}

/** What the cookie holds. */
interface SiteClaims {
  id: string
  person: SiteRecord["person"]
  roles: string[]
  expiresAt: number
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === "string")
}

function readClaims(value: unknown): SiteClaims | undefined {
  if (!(value instanceof Object)) return undefined
  const id: unknown = Reflect.get(value, "id")
  const person: unknown = Reflect.get(value, "person")
  const roles: unknown = Reflect.get(value, "roles")
  const expiresAt: unknown = Reflect.get(value, "expiresAt")
  if (typeof id !== "string" || !strings(roles) || typeof expiresAt !== "number" || !(person instanceof Object)) return undefined
  const [personId, name, email, image]: unknown[] = ["id", "name", "email", "image"].map(field => Reflect.get(person, field))
  if (typeof personId !== "string" || typeof name !== "string") return undefined
  return {
    id,
    person: { id: personId, name, ...(typeof email === "string" ? { email } : {}), ...(typeof image === "string" ? { image } : {}) },
    roles,
    expiresAt,
  }
}

function readRecord(value: string | null | undefined): SiteRecord | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    const claims = readClaims(parsed)
    const kind: unknown = Reflect.get(Object(parsed), "kind")
    const device: unknown = Reflect.get(Object(parsed), "device")
    const createdAt: unknown = Reflect.get(Object(parsed), "createdAt")
    if (!claims || (kind !== "member" && kind !== "guest") || typeof device !== "string" || typeof createdAt !== "number") return undefined
    return { ...claims, kind, device, createdAt }
  }
  catch {
    return undefined
  }
}

/**
 * Start a site session for a browser: keep it in the KV store and return its cookie. `secure` adds `Secure`, for an
 * app on HTTPS.
 */
export async function openConsoleSiteSession(input: { kind: SiteRecord["kind"], person: SiteRecord["person"], roles: string[], userAgent: string, secure: boolean }): Promise<string> {
  const key = await requireConsoleSiteKey()
  const kv = await consoleSiteKV()
  const now = Date.now()
  const record: SiteRecord = {
    id: crypto.randomUUID(),
    kind: input.kind,
    person: input.person,
    roles: [...new Set(input.roles)],
    device: userAgentDevice(input.userAgent),
    createdAt: now,
    expiresAt: now + consoleSiteLifetime * 1000,
  }
  unwrap(await kv.set(`${sessionPrefix}${record.id}`, JSON.stringify(record), { ttl: consoleSiteLifetime }))
  const claims: SiteClaims = { id: record.id, person: record.person, roles: record.roles, expiresAt: record.expiresAt }
  const sealed = await sealWithKey(key, encoder.encode(consoleSiteCookie), JSON.stringify(claims))
  return `${consoleSiteCookie}=${sealed}; Path=/; Max-Age=${consoleSiteLifetime}; HttpOnly; SameSite=Lax${input.secure ? "; Secure" : ""}`
}

function cookieValue(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const at = part.indexOf("=")
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

/**
 * The person of the `vitehub_site` cookie of a request. A cookie that does not open with the key of this app, that
 * expired, or whose session was revoked gives no person.
 */
export async function readConsoleSiteVisitor(request: Request): Promise<ViteHubSiteVisitor | undefined> {
  const value = cookieValue(request.headers.get("cookie") ?? "", consoleSiteCookie)
  if (!value) return undefined
  const key = await siteKey()
  if (!key) return undefined
  let claims: SiteClaims | undefined
  try {
    claims = readClaims(JSON.parse(await unsealWithKey(key, encoder.encode(consoleSiteCookie), value)))
  }
  catch {
    return undefined
  }
  if (!claims || claims.expiresAt <= Date.now()) return undefined
  const kv = await consoleSiteKV()
  const record = readRecord(unwrap(await kv.get(`${sessionPrefix}${claims.id}`, { type: "text" })))
  if (!record || record.expiresAt <= Date.now()) return undefined
  return { ...claims.person, roles: claims.roles }
}

/** The browsers that Site access signed in without Auth, most recently signed in first. */
export async function listConsoleSiteSessions(known: ReadonlySet<string>): Promise<SiteSession[]> {
  const kv = await consoleSiteKV()
  const keys = await consoleSiteKeys(kv, sessionPrefix)
  const records = await Promise.all(keys.map(async key => readRecord(unwrap(await kv.get(key, { type: "text" })))))
  return records
    .filter((record): record is SiteRecord => record !== undefined && record.expiresAt > Date.now())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(record => ({
      id: record.id,
      kind: record.kind,
      // A guest has no email.
      person: { ...record.person },
      grants: record.roles.filter(role => known.has(role)),
      device: record.device,
      createdAt: new Date(record.createdAt).toISOString(),
      lastSeenAt: new Date(record.createdAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
    }))
}

/** Revoke a site session: its cookie stops working. Returns whether the session was a guest's, or undefined without it. */
export async function revokeConsoleSiteSession(id: string): Promise<{ guest: boolean } | undefined> {
  const kv = await consoleSiteKV()
  const key = `${sessionPrefix}${id}`
  const record = readRecord(unwrap(await kv.get(key, { type: "text" })))
  if (!record) return undefined
  unwrap(await kv.delete(key))
  return { guest: record.kind === "guest" }
}
