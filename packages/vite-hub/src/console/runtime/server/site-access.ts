import { viteHubPageGrants } from "@vite-hub/internal/runtime/page-tools"
import { viteHubPageToolsResetCookie, viteHubSessionMarkerCookie } from "@vite-hub/internal/runtime/page-tools-shared"

import { readConsoleOperationUser, type ConsoleAccess } from "./access.ts"
import { consoleRequestError, type ConsoleRequestEvent } from "./request.ts"
import { consoleSiteKV, listConsoleSiteSessions, openConsoleSiteSession, requireConsoleSiteKey, revokeConsoleSiteSession } from "./site-session.ts"
import { appBase, appOrigin, authConsole, authFailure, base64url, consoleInvitePrefix, consoleRecordStore, issueConsoleTicket, seeOther, ticketProblem, type ConsoleTicket, type ConsoleTicketRecord } from "./tickets.ts"

import type { ViteHubPageGrant } from "@vite-hub/internal/runtime/page-tools"
import type { SiteGrant, SiteInvite, SiteSession } from "../site-access.ts"

/**
 * Site access: the Console signs browsers in to the app, so the page tools work there without a password.
 *
 * - A member of the Console team opens the site from the Console, or scans a QR code with a phone. `site.link` returns
 *   a one-time link, `GET /_vitehub/rpc?ticket=`. Its redemption signs the browser in as the app user with the email
 *   of the member, made if there is none, with the `console` role and the roles of every page tool.
 * - A member invites a guest with `site.invite`: a name, roles such as `comments-write`, and an expiry. The link works
 *   once, in one browser, and signs it in as a new user with that name and the `guest` role. Guests never get the
 *   Console.
 *
 * With Auth, the users, their roles, and the sessions are Better Auth's: the roles go in `user.role` of the `admin()`
 * plugin, and a browser is a Better Auth session, which ends as the app's session settings say. Revoking a guest's
 * browser deletes the guest. Without Auth, the browser gets the sealed `vitehub_site` cookie with the person and the
 * roles, and the app's KV store keeps its session (see `site-session.ts`).
 */

/** The role of a Console member: the **Console** link of the page tools pill. */
const consoleGrant: ViteHubPageGrant = { id: "console", label: "Console", description: "Open the app in the ViteHub Console. Members only." }
const guestRole = "guest"
/** A QR code is scanned with another device, which takes longer than a click, so its link lasts 10 minutes. */
const qrLinkLifetime = 10 * 60

type SiteContext = { access: ConsoleAccess, request?: Request, event?: unknown }

function isRequestEvent(value: unknown): value is ConsoleRequestEvent {
  return value instanceof Object && "~standard" in value
}

function contextRequest(context: SiteContext): Request {
  if (!context.request) throw consoleRequestError(400, "Site access needs the request of the call.")
  return context.request
}

/** The Auth Console of a request, or undefined in an app without Auth, where Site access uses its own cookie. */
async function auth(request: Request, event?: unknown) {
  return await authConsole(request, isRequestEvent(event) ? event : undefined)
}

/** Without Auth, Site access needs the secret of its cookie and a shared store before it makes a link. */
async function assertSiteAccess(request: Request, event?: unknown): Promise<void> {
  if (await auth(request, event)) return
  await requireConsoleSiteKey()
  await consoleSiteKV()
}

/** The roles of a member: `console` and the roles of every page tool. */
function memberRoles(): string[] {
  return [consoleGrant.id, ...viteHubPageGrants().map(grant => grant.id)]
}

/** The answer of an Auth Console call, or its failure as a Console error. */
async function unwrap<T>(call: Promise<[undefined, T] | [Parameters<typeof authFailure>[0], undefined]>): Promise<T> {
  const [error, value] = await call
  if (error) throw await authFailure(error)
  // SAFETY: A result without an error has its value.
  return value as T
}

function parse<T>(value: string): T | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    // SAFETY: Only `issueConsoleTicket()` writes values under the invite prefix.
    return parsed instanceof Object ? parsed as T : undefined
  }
  catch {
    return undefined
  }
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
 * Redeem a `page.member` or `page.guest` ticket: find or make the user, add the roles, start a Better Auth session for
 * the browser, and go to the page. The `vitehub_session` marker and the reset page tools hint make the next page ask
 * the session route again, as after a sign-in.
 */
export async function openSiteSession(record: ConsoleTicketRecord, request: Request, event: ConsoleRequestEvent): Promise<Response> {
  const location = targetPath(record)
  if (!location) return ticketProblem(401, "CONSOLE_TICKET_INVALID")
  const guest = record.purpose === "page.guest"
  const name = guest ? record.target.name : record.person.name ?? record.person.email
  if (!name) return ticketProblem(401, "CONSOLE_TICKET_INVALID")
  const roles = guest ? [guestRole, ...(record.target.grants ?? "").split(",").filter(Boolean)] : memberRoles()
  const api = await auth(request, event)
  const headers = new Headers()
  if (api) {
    const user = await unwrap(api.hostUser(guest
      ? { name, roles }
      : { email: record.person.email, name, ...(record.person.image ? { image: record.person.image } : {}), roles }))
    for (const cookie of (await unwrap(api.hostSession(user.id, request))).getSetCookie()) headers.append("set-cookie", cookie)
  }
  else {
    // A guest is only this browser, with an id of its invite. A member is the Console person.
    const person = guest
      ? { id: `site-guest:${record.target.invite ?? ""}`, name }
      : { id: record.person.id, name, ...(record.person.email ? { email: record.person.email } : {}), ...(record.person.image ? { image: record.person.image } : {}) }
    headers.append("set-cookie", await openConsoleSiteSession({ kind: guest ? "guest" : "member", person, roles, userAgent: request.headers.get("user-agent") ?? "", secure: record.origin.startsWith("https:") }))
  }
  const maxAge = /;\s*Max-Age=(\d+)/i.exec(headers.get("set-cookie") ?? "")?.[1]
  headers.append("set-cookie", `${viteHubSessionMarkerCookie}=1; Path=/; SameSite=Lax${maxAge ? `; Max-Age=${maxAge}` : ""}`)
  headers.append("set-cookie", viteHubPageToolsResetCookie)
  return seeOther(location, headers)
}

/** A page path of the app, such as `/runs/42`. */
function pagePath(path: string | undefined): string {
  if (!path) return "/"
  if (!path.startsWith("/") || path.startsWith("//")) throw consoleRequestError(400, "Use a path of the app, such as /runs/42.")
  return path
}

/** `site.link`: a one-time link that signs the browser that opens it in as you. With `qr`, it lasts 10 minutes. */
export async function linkSite(context: SiteContext, input: { path?: string, qr?: boolean }): Promise<ConsoleTicket> {
  await assertSiteAccess(contextRequest(context), context.event)
  return await issueConsoleTicket(context, "page.member", { path: pagePath(input.path).slice(1) }, input.qr ? { lifetime: qrLinkLifetime } : {})
}

function readGrants(grants: readonly string[]): string[] {
  const known = new Set(viteHubPageGrants().map(grant => grant.id))
  const unique = [...new Set(grants)]
  if (unique.includes(consoleGrant.id)) throw consoleRequestError(400, "Guests never get the Console. Invite them with the roles of the page tools, such as comments-write.")
  const unknown = unique.filter(grant => !known.has(grant))
  if (unknown.length) throw consoleRequestError(400, `The page tools of this app give no role ${unknown.join(", ")}. Read the roles with site.grants.`)
  if (!unique.length) throw consoleRequestError(400, "Pick at least one role.")
  return unique
}

/** `site.invite`: a guest invite with a name and roles. The link works once, in one browser. */
export async function inviteGuest(context: SiteContext, input: { name: string, grants: readonly string[], expiresInDays?: number, path?: string }): Promise<ConsoleTicket & { invite: SiteInvite }> {
  const name = input.name.trim()
  if (!name) throw consoleRequestError(400, "Give the guest a name. It is the author of their comments.")
  const grants = readGrants(input.grants)
  await assertSiteAccess(contextRequest(context), context.event)
  const days = input.expiresInDays ?? 7
  const path = pagePath(input.path)
  const id = base64url(crypto.getRandomValues(new Uint8Array(12)))
  const ticket = await issueConsoleTicket(context, "page.guest", { invite: id, name, grants: grants.join(","), path: path.slice(1) }, { lifetime: days * 24 * 60 * 60 })
  const user = await readConsoleOperationUser(context.access)
  const by = user ? String(Reflect.get(user, "name") ?? Reflect.get(user, "email") ?? user.id) : "Console member"
  return { ...ticket, invite: { id, name, grants, path, expiresAt: ticket.expiresAt, createdBy: { id: user?.id ?? "", name: by } } }
}

/** `site.invites`: the guest invites that nobody opened yet, newest first. */
export async function listInvites(context: SiteContext): Promise<{ invites: SiteInvite[] }> {
  const request = contextRequest(context)
  const rows = await (await consoleRecordStore(request, isRequestEvent(context.event) ? context.event : undefined)).list(consoleInvitePrefix)
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
  const records = await consoleRecordStore(contextRequest(context), isRequestEvent(context.event) ? context.event : undefined)
  const row = (await records.list(consoleInvitePrefix)).find(({ value }) => parse<ConsoleTicketRecord>(value)?.target.invite === id)
  if (!row) throw consoleRequestError(404, "No open invite has this id. It was opened, revoked, or it expired.")
  await records.remove(row.identifier)
  return { revoked: true }
}

/** `site.sessions`: the browsers of Console members and guests, most recently used first. */
export async function listSessions(context: SiteContext): Promise<{ sessions: SiteSession[] }> {
  const api = await auth(contextRequest(context), context.event)
  const known = new Set(memberRoles())
  if (!api) return { sessions: await listConsoleSiteSessions(known) }
  const rows = await unwrap(api.hostSessions([consoleGrant.id, guestRole]))
  return {
    sessions: rows.map(({ id, user, roles, device, createdAt, updatedAt, expiresAt }) => {
      const guest = roles.includes(guestRole)
      return {
        id,
        kind: guest ? "guest" : "member",
        // A guest's email is a placeholder.
        person: { id: user.id, name: user.name, ...(guest ? {} : { email: user.email }), ...(user.image ? { image: user.image } : {}) },
        grants: roles.filter(role => known.has(role)),
        device,
        createdAt,
        lastSeenAt: updatedAt,
        expiresAt,
      }
    }),
  }
}

/**
 * `site.revoke-session`: the browser is signed out. A guest has one browser, so revoking it deletes the guest too. In an
 * app without Auth, a guest is only that browser.
 */
export async function revokeSession(context: SiteContext, id: string): Promise<{ revoked: true, removedUser: boolean }> {
  const api = await auth(contextRequest(context), context.event)
  if (!api) {
    const revoked = await revokeConsoleSiteSession(id)
    if (!revoked) throw consoleRequestError(404, "No browser has this session. It was revoked, or it expired.")
    return { revoked: true, removedUser: revoked.guest }
  }
  const { userId, roles } = await unwrap(api.revokeHostSession(id))
  const removedUser = roles.includes(guestRole)
  if (removedUser) await unwrap(api.removeHostUser(userId))
  return { revoked: true, removedUser }
}

/** `site.grants`: the roles that Site access gives. `console` is for members only. */
export function listGrants(): { grants: SiteGrant[] } {
  return { grants: [{ ...consoleGrant, membersOnly: true }, ...viteHubPageGrants()] }
}
