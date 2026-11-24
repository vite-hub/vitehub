import { renderSVG } from "uqr"

import { isRecord } from "@vite-hub/internal/object"

import { useConsoleProjects } from "./project-session"
import { ConsoleRequestError, consoleResponseError } from "./request"
import { openConsoleTicket } from "./ticket"

import type { ConsoleTicketLink } from "./ticket"

/** A browser that Site access signed in to the app: its pass in the ViteHub Console. */
export interface SiteSession {
  id: string
  kind: "member" | "guest"
  person: { id: string, name: string, email?: string, image?: string }
  /** The roles of the person, such as `comments-write`, and `console` for a member. */
  grants: string[]
  /** Such as `Chrome · macOS`. */
  device: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
}

/** A guest invite that nobody opened yet. */
export interface SiteInvite {
  id: string
  name: string
  grants: string[]
  path: string
  expiresAt: string
  createdBy: { id: string, name: string }
}

/** A role that Site access may give, such as `comments-write`. `console` is for members only. */
export interface SiteGrant {
  id: string
  label: string
  description?: string
  membersOnly?: true
}

/** Whether a Site access request was refused with a reason to show, such as a missing role or a bad invite. */
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

/** Everything the Site access section shows, read from the Console in one go. */
export async function readSiteAccess(signal?: AbortSignal): Promise<{ sessions: SiteSession[], invites: SiteInvite[], grants: SiteGrant[] }> {
  const body = await siteApi("GET", "", signal ? { signal } : {})
  return { sessions: listOf(body, "sessions", isSession), invites: listOf(body, "invites", isInvite), grants: listOf(body, "grants", isGrant) }
}

/**
 * Opens the app in a new tab, signed in as you. The tab opens `<app>/_vitehub/site?project=<id>`, which goes through the
 * Console, with the pass and the policy of this project, and back to the page.
 */
export async function openSite(path?: string): Promise<void> {
  const { id, url } = currentProject()
  await openConsoleTicket(async () => ({ url: `${url.replace(/\/+$/, "")}/_vitehub/site?${new URLSearchParams({ return: path ?? "/", project: id })}` }))
}

/** A one-time link for a phone, such as `/go/<code>` of the Console: it lasts 10 minutes, so there is time to scan it. */
export async function phoneLink(): Promise<ConsoleTicketLink> {
  return linkOf(await siteApi("POST", "/codes", { body: {} }))
}

/** Invites a guest. The answer has the link, which the Console shows once: the Console keeps only its hash. */
export async function inviteGuest(input: { name: string, grants: string[], expiresInDays: 1 | 7 | 30 }): Promise<ConsoleTicketLink & { invite: SiteInvite }> {
  const body = await siteApi("POST", "/invites", { body: input })
  if (!isInvite(body.invite)) throw new ConsoleRequestError(502, "The answer has no invite.")
  return { ...linkOf(body), invite: body.invite }
}

/** Revokes the pass of a browser. */
export async function revokeSession(id: string): Promise<void> {
  await siteApi("DELETE", `/sessions/${encodeURIComponent(id)}`)
}

/** Revokes a guest invite that nobody opened yet. */
export async function revokeInvite(id: string): Promise<void> {
  await siteApi("DELETE", `/invites/${encodeURIComponent(id)}`)
}

/** The QR code of a link as SVG markup. It draws with `currentColor`, so it follows the theme. */
export function qrCode(url: string): string {
  return renderSVG(url, { border: 1, blackColor: "currentColor", whiteColor: "transparent" })
}

/**
 * What a browser may do, in words: the labels of its grants, such as `Read comments, Write comments`. Grants the
 * catalogue does not know keep their id.
 */
export function grantSummary(grants: readonly string[], catalogue: readonly SiteGrant[]): string {
  const labels = grants.map(id => catalogue.find(grant => grant.id === id)?.label ?? id)
  return labels.length ? labels.join(", ") : "Nothing"
}
