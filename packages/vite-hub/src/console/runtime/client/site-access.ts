import { renderSVG } from "uqr"

import { isRecord } from "@vite-hub/internal/object"
import { siteAccessOperation } from "@vite-hub/internal/site-token"

import { siteAccessOperations } from "../site-access"
import { useConsoleProjects } from "./project-session"
import { ConsoleRequestError, consoleResponseError, requestConsoleOperation } from "./request"
import { openConsoleTicket } from "./ticket"

import type { SiteGrant, SiteInvite, SiteSession } from "../site-access"
import type { ConsoleTicketLink } from "./ticket"

export type { SiteGrant, SiteInvite, SiteSession } from "../site-access"

/**
 * Whether the Console keeps the Site access of the open project: the account Console, with an app that answers
 * `site.access`. Else the app keeps it, and the Console calls its `site.*` operations.
 */
export function usesConsoleSiteAccess(): boolean {
  const projects = useConsoleProjects()
  return projects.mode === "account" && Boolean(projects.current.value) && Boolean(projects.info.value?.operations.includes(siteAccessOperation))
}

/**
 * Whether a Site access request was refused with a reason to show: any refusal of the Console, such as a missing role or
 * a bad invite, or the Auth setup guidance of an app that keeps Site access itself.
 */
export function isSiteAccessProblem(error: unknown): error is ConsoleRequestError {
  return error instanceof ConsoleRequestError && (usesConsoleSiteAccess() || error.code === "AUTH_CONSOLE_UNAVAILABLE")
}

async function appOperation(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const body = await requestConsoleOperation(operation, input, signal ? { signal } : {})
  if (!isRecord(body)) throw new ConsoleRequestError(502, `The app answered ${operation} with no JSON object.`)
  return body
}

function currentProject(): { id: string, url: string } {
  const project = useConsoleProjects().current.value
  if (!project) throw new ConsoleRequestError(409, "Open a project to manage its Site access.")
  return project
}

async function siteApi(method: "GET" | "POST" | "DELETE", path: string, input: { body?: unknown, signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/projects/${encodeURIComponent(currentProject().id)}/site${path}`, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...(input.body === undefined ? {} : { "content-type": "application/json" }) },
    method,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!response.ok) throw await consoleResponseError(response)
  const body: unknown = await response.json().catch(() => undefined)
  if (!isRecord(body)) throw new ConsoleRequestError(502, "The Console answered Site access with no JSON object.")
  return body
}

function linkOf(body: Record<string, unknown>): ConsoleTicketLink {
  const { url, expiresAt } = body
  if (typeof url !== "string" || typeof expiresAt !== "string") throw new ConsoleRequestError(502, "The Console answered without a link.")
  return { url, expiresAt }
}

function listOf<T>(body: Record<string, unknown>, name: string, isItem: (value: unknown) => value is T): T[] {
  const value = body[name]
  if (!Array.isArray(value) || !value.every(isItem)) throw new ConsoleRequestError(502, `The Console answered Site access without a list of ${name}.`)
  return value
}

function hasId(value: unknown): value is Record<string, unknown> & { id: string } {
  return isRecord(value) && typeof value.id === "string"
}

function isSession(value: unknown): value is SiteSession {
  return hasId(value) && (value.kind === "member" || value.kind === "guest") && isRecord(value.person) && Array.isArray(value.grants)
}

function isInvite(value: unknown): value is SiteInvite {
  return hasId(value) && typeof value.name === "string" && Array.isArray(value.grants) && typeof value.expiresAt === "string"
}

function isGrant(value: unknown): value is SiteGrant {
  return hasId(value) && typeof value.label === "string"
}

async function readAppSiteAccess(signal?: AbortSignal): Promise<{ sessions: SiteSession[], invites: SiteInvite[], grants: SiteGrant[], sessionsError?: ConsoleRequestError }> {
  const [sessions, invites, grants] = await Promise.all([
    appOperation(siteAccessOperations.sessions, {}, signal).catch((error: unknown) => {
      if (error instanceof ConsoleRequestError && error.code === "AUTH_CONSOLE_UNAVAILABLE") return error
      throw error
    }),
    appOperation(siteAccessOperations.invites, {}, signal),
    appOperation(siteAccessOperations.grants, {}, signal),
  ])
  return {
    ...(sessions instanceof ConsoleRequestError ? { sessions: [], sessionsError: sessions } : { sessions: listOf(sessions, "sessions", isSession) }),
    invites: listOf(invites, "invites", isInvite),
    grants: listOf(grants, "grants", isGrant),
  }
}

/**
 * Everything the Site access section shows, read in one go: from the Console, or from the app when the app keeps Site
 * access. `sessionsError` is the Auth setup guidance of an app that cannot list its site browsers.
 */
export async function readSiteAccess(signal?: AbortSignal): Promise<{ sessions: SiteSession[], invites: SiteInvite[], grants: SiteGrant[], sessionsError?: ConsoleRequestError }> {
  if (!usesConsoleSiteAccess()) return await readAppSiteAccess(signal)
  const body = await siteApi("GET", "", signal ? { signal } : {})
  return { sessions: listOf(body, "sessions", isSession), invites: listOf(body, "invites", isInvite), grants: listOf(body, "grants", isGrant) }
}

/**
 * Opens the app in a new tab, signed in as you. With Site access in the Console, the tab opens
 * `<app>/_vitehub/site?project=<id>`, which goes through the Console, with the pass and the policy of this project, and
 * back to the page. Else the app signs the tab in with a link of its own.
 */
export async function openSite(path?: string): Promise<void> {
  if (!usesConsoleSiteAccess()) {
    await openConsoleTicket(() => appOperation(siteAccessOperations.link, path ? { path } : {}))
    return
  }
  const { id, url } = currentProject()
  await openConsoleTicket(async () => ({ url: `${url.replace(/\/+$/, "")}/_vitehub/site?${new URLSearchParams({ return: path ?? "/", project: id })}` }))
}

/** A one-time link for a phone, such as `/go/<code>` of the Console: it lasts 10 minutes, so there is time to scan it. */
export async function phoneLink(): Promise<ConsoleTicketLink> {
  return linkOf(usesConsoleSiteAccess() ? await siteApi("POST", "/codes", { body: {} }) : await appOperation(siteAccessOperations.link, { qr: true }))
}

/** Invites a guest. The answer has the link, which the Console shows once: the Console or the app keeps only its hash. */
export async function inviteGuest(input: { name: string, grants: string[], expiresInDays: 1 | 7 | 30 }): Promise<ConsoleTicketLink & { invite: SiteInvite }> {
  const body = usesConsoleSiteAccess() ? await siteApi("POST", "/invites", { body: input }) : await appOperation(siteAccessOperations.invite, input)
  if (!isInvite(body.invite)) throw new ConsoleRequestError(502, "The answer has no invite.")
  return { ...linkOf(body), invite: body.invite }
}

/** Revokes the pass of a browser, or its app session when the app keeps Site access. */
export async function revokeSession(id: string): Promise<void> {
  if (usesConsoleSiteAccess()) await siteApi("DELETE", `/sessions/${encodeURIComponent(id)}`)
  else await appOperation(siteAccessOperations.revokeSession, { id })
}

export async function revokeInvite(id: string): Promise<void> {
  if (usesConsoleSiteAccess()) await siteApi("DELETE", `/invites/${encodeURIComponent(id)}`)
  else await appOperation(siteAccessOperations.revokeInvite, { id })
}

/** The QR code of a link as SVG markup. It draws with `currentColor`, so it follows the theme. */
export function qrCode(url: string): string {
  return renderSVG(url, { border: 1, blackColor: "currentColor", whiteColor: "transparent" })
}

/**
 * What a browser may do, in words: `Console and every page tool` for a member, else the labels of its grants, such as
 * `Read comments, Write comments`. Grants the catalogue does not know keep their id.
 */
export function grantSummary(kind: "member" | "guest", grants: readonly string[], catalogue: readonly SiteGrant[]): string {
  if (kind === "member") return "Console and every page tool"
  const labels = grants.map(id => catalogue.find(grant => grant.id === id)?.label ?? id)
  return labels.length ? labels.join(", ") : "Nothing"
}
