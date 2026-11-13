import { renderSVG } from "uqr"

import { siteAccessOperations } from "../site-access"
import { requestConsoleOperation } from "./request"
import { openConsoleTicket } from "./ticket"

import type { SiteGrant, SiteInvite, SiteSession } from "../site-access"
import type { ConsoleTicketLink } from "./ticket"

export type { SiteGrant, SiteInvite, SiteSession } from "../site-access"

/** Everything the Site access section shows, read in one go. */
export async function readSiteAccess(signal?: AbortSignal): Promise<{ sessions: SiteSession[], invites: SiteInvite[], grants: SiteGrant[] }> {
  const options = signal ? { signal } : {}
  const [sessions, invites, grants] = await Promise.all([
    requestConsoleOperation(siteAccessOperations.sessions, {}, options),
    requestConsoleOperation(siteAccessOperations.invites, {}, options),
    requestConsoleOperation(siteAccessOperations.grants, {}, options),
  ])
  // SAFETY: These operations answer with the shapes of `server/site-access.ts`.
  return { sessions: (sessions as { sessions: SiteSession[] }).sessions, invites: (invites as { invites: SiteInvite[] }).invites, grants: (grants as { grants: SiteGrant[] }).grants }
}

/** Opens the app in a new tab, and signs that browser in as you on the way. */
export async function openSite(path?: string): Promise<void> {
  await openConsoleTicket(() => requestConsoleOperation(siteAccessOperations.link, path ? { path } : {}))
}

/** A one-time link for a phone: it lasts 10 minutes, so there is time to scan it. */
export async function phoneLink(): Promise<ConsoleTicketLink> {
  // SAFETY: `site.link` answers with a ticket link.
  return await requestConsoleOperation(siteAccessOperations.link, { qr: true }) as ConsoleTicketLink
}

/** Invites a guest. The answer has the link, which the Console shows once: the app keeps only its hash. */
export async function inviteGuest(input: { name: string, grants: string[], expiresInDays: 1 | 7 | 30 }): Promise<ConsoleTicketLink & { invite: SiteInvite }> {
  // SAFETY: `site.invite` answers with a ticket link and the invite.
  return await requestConsoleOperation(siteAccessOperations.invite, input) as ConsoleTicketLink & { invite: SiteInvite }
}

export async function revokeSession(id: string): Promise<void> {
  await requestConsoleOperation(siteAccessOperations.revokeSession, { id })
}

export async function revokeInvite(id: string): Promise<void> {
  await requestConsoleOperation(siteAccessOperations.revokeInvite, { id })
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
