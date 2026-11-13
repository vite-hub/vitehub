import { readConsolePublicKeys } from "@vite-hub/internal/console-signature"
import { viteHubPageGrants, viteHubPagePassLifetime } from "@vite-hub/internal/runtime/page-tools"
import { viteHubPageToolsHintCookie } from "@vite-hub/internal/runtime/page-tools-shared"
import { getStandardContext } from "@vite-hub/runtime/h3"

import { readConsoleOperationUser, type ConsoleAccess } from "./access.ts"
import { consoleRequestError, type ConsoleRequestEvent } from "./request.ts"
import { appBase, appOrigin, base64url, consoleInvitePrefix, consoleRecordStore, issueConsoleTicket, secretDigest, seeOther, ticketProblem, type ConsoleRecordStore, type ConsoleTicket, type ConsoleTicketRecord } from "./tickets.ts"

import type { ViteHubPageGrant, ViteHubPagePass } from "@vite-hub/internal/runtime/page-tools"
import type { SiteGrant, SiteInvite, SitePass } from "../site-access.ts"

/**
 * Site access: browsers that the Console linked to the app, so the page tools work there without an app sign-in.
 *
 * - A member of the Console team opens the site from the Console, or scans a QR code with a phone. The `site.link`
 *   operation returns a one-time link, `GET /_vitehub/rpc?ticket=`, and its redemption gives the browser a pass.
 * - A member invites a guest with `site.invite`: a name, the grants, such as `comments.write`, and an expiry.
 *   The link works once, in one browser. The guest never sees the Console.
 *
 * A pass is the `vitehub-pass` cookie: 32 random bytes, HttpOnly. The app keeps only its SHA-256, in the store of the
 * one-time links, with the person, the grants, the device, and the name of the Console key that signed the call that
 * made it. A pass lasts 90 days after its last use. Revoking it in the Console deletes the record. Removing the
 * `VITEHUB_CONSOLE_KEY_<NAME>` variable of the key, as unlinking the app does, ends every pass that the key made.
 */

/** The cookie of a page pass. */
const pagePassCookie = "vitehub-pass"
const passPrefix = "vitehub-page-pass:"
const passPattern = /^vp1_[\w-]{43}$/
/** Cookies can last at most 400 days. The record decides when the pass ends. */
const cookieMaxAge = 400 * 24 * 60 * 60
/** A pass refreshes its record at most once a day, so a busy page does not write on every request. */
const refreshAfter = 24 * 60 * 60 * 1000
/** The Console grant: the **Console** link of the page tools pill. Only members hold it. */
const consoleGrant: ViteHubPageGrant = { id: "console", label: "Console", description: "Open the app in the ViteHub Console. Members only." }
/** A QR code is scanned with another device, which takes longer than a click, so its link lasts 10 minutes. */
const qrLinkLifetime = 10 * 60

interface PassRecord {
  id: string
  kind: "member" | "guest"
  person: { id: string, name: string, email?: string, image?: string }
  /** The grants of a guest. A member holds `console` and every grant that the page tools declare, at each read. */
  grants: string[]
  /** The name of the Console key that signed the call. Not set on a development server. */
  key?: string
  device: string
  createdAt: number
  lastSeenAt: number
  createdBy: { id: string, name: string }
  /** The invite that made a guest pass. */
  invite?: string
}

/** A short device label from a user agent, such as `Chrome on macOS`. The full user agent is never kept. */
function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "A browser"
  const os = /iPhone/.test(userAgent) ? "iPhone" : /iPad/.test(userAgent) ? "iPad" : /Android/.test(userAgent) ? "Android" : /Windows/.test(userAgent) ? "Windows" : /Macintosh/.test(userAgent) ? "macOS" : /Linux/.test(userAgent) ? "Linux" : "an unknown device"
  return `${browser} on ${os}`
}

function randomId(bytes = 12): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

function parse<T>(value: string | null): T | undefined {
  if (value === null) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    // SAFETY: Only this module and `issueConsoleTicket()` write values under these prefixes.
    return parsed instanceof Object ? parsed as T : undefined
  }
  catch {
    return undefined
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=")
    if (key === name) return value.join("=")
  }
  return undefined
}

function isRequestEvent(value: unknown): value is ConsoleRequestEvent {
  return value instanceof Object && "~standard" in value
}

/** The names of the Console keys in the host env of a request or event, as the signature check reads them. */
function consoleKeyNames(source: unknown): Set<string> {
  const env = { ...globalThis.process?.env, ...(isRequestEvent(source) ? getStandardContext(source).runtime?.cloudflare?.env : undefined) }
  const keys = readConsolePublicKeys(env)
  return keys instanceof Map ? new Set(keys.keys()) : new Set()
}

/** The grants a page tool may give: the ones that the registered page tools declare. */
function pageGrantCatalogue(): ViteHubPageGrant[] {
  return viteHubPageGrants()
}

function memberGrants(): string[] {
  return [consoleGrant.id, ...pageGrantCatalogue().map(grant => grant.id)]
}

/** A pass record that still works: its key is still in the env. */
function live(record: PassRecord, keys: Set<string>): boolean {
  return !record.key || keys.has(record.key)
}

async function store(request: Request): Promise<ConsoleRecordStore> {
  return await consoleRecordStore(request, isRequestEvent(request) ? request : undefined)
}

/**
 * The page pass of a request, for the page tools: the `vitehub-pass` cookie, its record, and a key that still exists.
 * A record that its key outlived is deleted. Once a day of use, the pass lasts 90 days more.
 */
export async function readConsolePagePass(request: Request): Promise<ViteHubPagePass | undefined> {
  const token = cookieValue(request, pagePassCookie)
  if (!token || !passPattern.test(token)) return undefined
  const records = await store(request)
  const identifier = `${passPrefix}${await secretDigest(token)}`
  const record = parse<PassRecord>(await records.read(identifier))
  if (!record) return undefined
  if (!live(record, consoleKeyNames(request))) {
    await records.remove(identifier)
    return undefined
  }
  const now = Date.now()
  if (now - record.lastSeenAt > refreshAfter) {
    await records.update(identifier, JSON.stringify({ ...record, lastSeenAt: now }), new Date(now + viteHubPagePassLifetime * 1000))
  }
  return { id: record.id, kind: record.kind, person: record.person, grants: record.kind === "member" ? memberGrants() : record.grants }
}

function passCookie(token: string, secure: boolean): string {
  return `${pagePassCookie}=${token}; Path=/; Max-Age=${cookieMaxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
}

/** The path of a ticket target below the app origin, or the app base. A full URL to another origin is refused. */
function targetPath(record: ConsoleTicketRecord): string | undefined {
  const home = `${record.origin}${record.base}/`
  const path = record.target.path
  if (!path) return home
  const url = new URL(path, home)
  return url.origin === record.origin ? url.href : undefined
}

/**
 * Redeem a `page.member` or `page.guest` ticket: make the pass, set its cookie and the page tools hint, and go to the
 * page. A pass that the browser already holds is replaced, so one browser is one entry in the Console.
 */
export async function openPagePass(record: ConsoleTicketRecord, request: Request, event: ConsoleRequestEvent): Promise<Response> {
  const location = targetPath(record)
  if (!location) return ticketProblem(401, "CONSOLE_TICKET_INVALID")
  if (record.key && !consoleKeyNames(event).has(record.key)) {
    return ticketProblem(403, "CONSOLE_TICKET_MISMATCH", "The Console key that made this link is no longer set on the app.")
  }
  const records = await consoleRecordStore(request, event)
  const previous = cookieValue(request, pagePassCookie)
  if (previous && passPattern.test(previous)) await records.remove(`${passPrefix}${await secretDigest(previous)}`)
  const guest = record.purpose === "page.guest"
  const name = guest ? record.target.name : record.person.name ?? record.person.email ?? "Console member"
  if (!name) return ticketProblem(401, "CONSOLE_TICKET_INVALID")
  const now = Date.now()
  const pass: PassRecord = {
    id: randomId(),
    kind: guest ? "guest" : "member",
    person: guest
      ? { id: `pass:${record.target.invite ?? randomId()}`, name }
      : { id: record.person.id, name, ...(record.person.email ? { email: record.person.email } : {}), ...(record.person.image ? { image: record.person.image } : {}) },
    grants: guest ? (record.target.grants ?? "").split(",").filter(Boolean) : [consoleGrant.id],
    ...(record.key ? { key: record.key } : {}),
    device: deviceLabel(request.headers.get("user-agent") ?? ""),
    createdAt: now,
    lastSeenAt: now,
    createdBy: { id: record.person.id, name: record.person.name ?? record.person.email ?? "Console member" },
    ...(guest && record.target.invite ? { invite: record.target.invite } : {}),
  }
  const token = `vp1_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`
  await records.save(`${passPrefix}${await secretDigest(token)}`, JSON.stringify(pass), new Date(now + viteHubPagePassLifetime * 1000))
  const headers = new Headers()
  headers.append("set-cookie", passCookie(token, new URL(request.url).protocol === "https:"))
  headers.append("set-cookie", viteHubPageToolsHintCookie(true, viteHubPagePassLifetime))
  return seeOther(location, headers)
}

type SiteContext = { access: ConsoleAccess, request?: Request, event?: unknown }

function contextRequest(context: SiteContext): Request {
  if (!context.request) throw consoleRequestError(400, "Site access needs the request of the call.")
  return context.request
}

async function contextStore(context: SiteContext): Promise<ConsoleRecordStore> {
  return await consoleRecordStore(contextRequest(context), isRequestEvent(context.event) ? context.event : undefined)
}

/** A page path of the app, such as `/runs/42`. */
function pagePath(path: string | undefined): string {
  if (!path) return "/"
  if (!path.startsWith("/") || path.startsWith("//")) throw consoleRequestError(400, "Use a path of the app, such as /runs/42.")
  return path
}

/** `site.link`: a one-time link that gives the browser that opens it a member pass. With `qr`, it lasts 10 minutes. */
export async function linkSite(context: SiteContext, input: { path?: string, qr?: boolean }): Promise<ConsoleTicket> {
  return await issueConsoleTicket(context, "page.member", { path: pagePath(input.path).slice(1) }, input.qr ? { lifetime: qrLinkLifetime } : {})
}

function readGrants(grants: readonly string[]): string[] {
  const known = new Set(pageGrantCatalogue().map(grant => grant.id))
  const unique = [...new Set(grants)]
  if (unique.includes(consoleGrant.id)) throw consoleRequestError(400, "Guests never get the Console. Invite them with the grants of the page tools, such as comments.write.")
  const unknown = unique.filter(grant => !known.has(grant))
  if (unknown.length) throw consoleRequestError(400, `The page tools of this app give no grant ${unknown.join(", ")}. Read the grants with site.grants.`)
  if (!unique.length) throw consoleRequestError(400, "Pick at least one grant.")
  return unique
}

/** `site.invite`: a guest invite with a name and grants. The link works once, in one browser. */
export async function inviteGuest(context: SiteContext, input: { name: string, grants: readonly string[], expiresInDays?: number, path?: string }): Promise<ConsoleTicket & { invite: SiteInvite }> {
  const name = input.name.trim()
  if (!name) throw consoleRequestError(400, "Give the guest a name. It is the author of their comments.")
  const grants = readGrants(input.grants)
  const days = input.expiresInDays ?? 7
  const path = pagePath(input.path)
  const id = randomId()
  const ticket = await issueConsoleTicket(context, "page.guest", { invite: id, name, grants: grants.join(","), path: path.slice(1) }, { lifetime: days * 24 * 60 * 60 })
  const user = await readConsoleOperationUser(context.access)
  const by = user ? String(Reflect.get(user, "name") ?? Reflect.get(user, "email") ?? user.id) : "Console member"
  return { ...ticket, invite: { id, name, grants, path, expiresAt: ticket.expiresAt, createdBy: { id: user?.id ?? "", name: by } } }
}

/** `site.invites`: the guest invites that nobody opened yet, newest first. */
export async function listInvites(context: SiteContext): Promise<{ invites: SiteInvite[] }> {
  const request = contextRequest(context)
  const rows = await (await contextStore(context)).list(consoleInvitePrefix)
  const origin = appOrigin(request)
  const base = appBase(request)
  const invites = rows.flatMap(({ value, expiresAt }) => {
    const record = parse<ConsoleTicketRecord>(value)
    if (!record || record.purpose !== "page.guest" || record.origin !== origin || record.base !== base) return []
    return [{
      id: record.target.invite ?? "",
      name: record.target.name ?? "",
      grants: (record.target.grants ?? "").split(",").filter(Boolean),
      path: `/${record.target.path ?? ""}`,
      expiresAt: expiresAt.toISOString(),
      createdBy: { id: record.person.id, name: record.person.name ?? record.person.email ?? "Console member" },
    }]
  })
  return { invites: invites.sort((a, b) => b.expiresAt.localeCompare(a.expiresAt)) }
}

/** `site.revoke-invite`: the link of the invite stops working. */
export async function revokeInvite(context: SiteContext, id: string): Promise<{ revoked: true }> {
  const records = await contextStore(context)
  const rows = await records.list(consoleInvitePrefix)
  const row = rows.find(({ value }) => parse<ConsoleTicketRecord>(value)?.target.invite === id)
  if (!row) throw consoleRequestError(404, "No open invite has this id. It was opened, revoked, or it expired.")
  await records.remove(row.identifier)
  return { revoked: true }
}

/** `site.passes`: the browsers that hold a pass, most recently used first. Passes of a removed key are left out. */
export async function listPasses(context: SiteContext): Promise<{ passes: SitePass[] }> {
  const request = contextRequest(context)
  const keys = consoleKeyNames(context.event ?? request)
  const rows = await (await contextStore(context)).list(passPrefix)
  const passes = rows.flatMap(({ value, expiresAt }) => {
    const record = parse<PassRecord>(value)
    if (!record || !live(record, keys)) return []
    return [{
      id: record.id,
      kind: record.kind,
      person: record.person,
      grants: record.kind === "member" ? memberGrants() : record.grants,
      device: record.device,
      createdAt: new Date(record.createdAt).toISOString(),
      lastSeenAt: new Date(record.lastSeenAt).toISOString(),
      expiresAt: expiresAt.toISOString(),
      createdBy: record.createdBy,
    }]
  })
  return { passes: passes.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)) }
}

/** `site.revoke-pass`: the browser loses its pass on its next request. */
export async function revokePass(context: SiteContext, id: string): Promise<{ revoked: true }> {
  const records = await contextStore(context)
  const row = (await records.list(passPrefix)).find(({ value }) => parse<PassRecord>(value)?.id === id)
  if (!row) throw consoleRequestError(404, "No browser holds a pass with this id. It was revoked, or it expired.")
  await records.remove(row.identifier)
  return { revoked: true }
}

/** `site.grants`: what a pass may hold. `console` is for members only. */
export function listGrants(): { grants: SiteGrant[] } {
  return { grants: [{ ...consoleGrant, membersOnly: true }, ...pageGrantCatalogue()] }
}
