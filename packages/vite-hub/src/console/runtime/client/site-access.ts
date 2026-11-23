import { renderSVG } from "uqr"

import { isRecord } from "@vite-hub/internal/object"

import { useConsoleProjects } from "./project-session"
import { ConsoleRequestError, consoleResponseError } from "./request"
import { openConsoleTicket } from "./ticket"

import type { SiteGrant, SiteInvite, SiteSession } from "../site-access"
import type { ConsoleTicketLink } from "./ticket"

export type { SiteGrant, SiteInvite, SiteSession } from "../site-access"

/** Whether the Console refused a Site access request with a reason to show, such as a missing role or a bad invite. */
export function isSiteAccessProblem(error: unknown): error is ConsoleRequestError {
  return error instanceof ConsoleRequestError
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

/** Everything the Site access section shows, read in one go from the Console. */
export async function readSiteAccess(signal?: AbortSignal): Promise<{ sessions: SiteSession[], invites: SiteInvite[], grants: SiteGrant[] }> {
  const body = await siteApi("GET", "", signal ? { signal } : {})
  return { sessions: listOf(body, "sessions", isSession), invites: listOf(body, "invites", isInvite), grants: listOf(body, "grants", isGrant) }
}

/**
 * Opens the app in a new tab at `<app>/_vitehub/site`. The app sends the tab to the Console, which signs it in as you,
 * and back to the page.
 */
export async function openSite(path = "/"): Promise<void> {
  const { url } = currentProject()
  await openConsoleTicket(async () => ({ url: `${url.replace(/\/+$/, "")}/_vitehub/site?${new URLSearchParams({ return: path })}` }))
}

/** A one-time code for a phone, `/go/<code>` of the Console: it lasts 10 minutes, so there is time to scan it. */
export async function phoneLink(): Promise<ConsoleTicketLink> {
  return linkOf(await siteApi("POST", "/codes", { body: {} }))
}

/** Invites a guest. The answer has the link, `/i/<id>` of the Console, which the Console shows once: it keeps only its hash. */
export async function inviteGuest(input: { name: string, grants: string[], expiresInDays: 1 | 7 | 30 }): Promise<ConsoleTicketLink & { invite: SiteInvite }> {
  const body = await siteApi("POST", "/invites", { body: input })
  if (!isInvite(body.invite)) throw new ConsoleRequestError(502, "The Console answered without the invite.")
  return { ...linkOf(body), invite: body.invite }
}

/** Revokes the pass of a browser. The Console signs no new token for it; the app keeps a token that it already took until its session ends. */
export async function revokeSession(id: string): Promise<void> {
  await siteApi("DELETE", `/sessions/${encodeURIComponent(id)}`)
}

export async function revokeInvite(id: string): Promise<void> {
  await siteApi("DELETE", `/invites/${encodeURIComponent(id)}`)
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
