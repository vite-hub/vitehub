import type { ConsoleRpcResult } from "../../packages/vite-hub/src/console/runtime/rpc.ts"
import type { SiteGrant, SiteInvite, SiteSession } from "../../packages/vite-hub/src/console/runtime/site-access.ts"

/**
 * Site access: three signed-in browsers and one open invite, in memory. A restart resets them. Links point at the
 * playground home, because the playground has no app that redeems them.
 */
const hour = 3_600_000
const day = 24 * hour
const now = Date.now()
const maxi = { id: "console-maxi", name: "Maxi" }
const grants: SiteGrant[] = [
  { id: "console", label: "Console", description: "Open the app in the ViteHub Console. Members only.", membersOnly: true },
  { id: "comments-read", label: "Read comments", description: "See the comments on every page." },
  { id: "comments-write", label: "Write comments", description: "Start threads and reply." },
  { id: "comments-resolve", label: "Resolve threads", description: "Resolve and reopen threads." },
  { id: "comments-delete", label: "Delete comments", description: "Delete threads and messages." },
]
const all = grants.map(grant => grant.id)
let sessions: SiteSession[] = [
  { id: "pass-laptop", kind: "member", person: { ...maxi, email: "maxi@example.com" }, grants: all, device: "Chrome · macOS", createdAt: new Date(now - 40 * day).toISOString(), lastSeenAt: new Date(now - 4 * 60_000).toISOString(), expiresAt: new Date(now + 7 * day).toISOString() },
  { id: "pass-phone", kind: "member", person: { ...maxi, email: "maxi@example.com" }, grants: all, device: "Safari · iOS", createdAt: new Date(now - 12 * day).toISOString(), lastSeenAt: new Date(now - 3 * day).toISOString(), expiresAt: new Date(now + 4 * day).toISOString() },
  { id: "pass-ana", kind: "guest", person: { id: "user-ana", name: "Ana from design" }, grants: ["comments-read", "comments-write"], device: "Firefox · Windows", createdAt: new Date(now - 6 * day).toISOString(), lastSeenAt: new Date(now - 5 * hour).toISOString(), expiresAt: new Date(now + 7 * day).toISOString() },
]
let invites: SiteInvite[] = [
  { id: "invite-leo", name: "Leo (QA)", grants: ["comments-read", "comments-write", "comments-resolve"], path: "/", expiresAt: new Date(now + 5 * day).toISOString(), createdBy: maxi },
]
let next = 0

function link(origin: string, minutes: number): { url: string, expiresAt: string } {
  return { url: `${new URL(origin).origin}/_vitehub/rpc?ticket=vt1_playground${String(next++).padStart(31, "0")}`, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() }
}

function missing(what: string): ConsoleRpcResult {
  return { code: "CONSOLE_REQUEST_INVALID", message: `No ${what} has this id.`, ok: false, status: 404 }
}

/** Answers a `site.*` operation, or undefined for any other operation. */
export function siteFixture(origin: string, operation: string, input: Record<string, unknown>): ConsoleRpcResult | undefined {
  switch (operation) {
    case "site.sessions": return { ok: true, value: { sessions } }
    case "site.invites": return { ok: true, value: { invites } }
    case "site.grants": return { ok: true, value: { grants } }
    case "site.link": return { ok: true, value: input.qr ? link(origin, 10) : { url: "/", expiresAt: new Date(Date.now() + 60_000).toISOString() } }
    case "site.invite": {
      const days = Number(input.expiresInDays ?? 7)
      const invite: SiteInvite = { id: `invite-${next}`, name: String(input.name ?? ""), grants: Array.isArray(input.grants) ? input.grants.map(String) : [], path: "/", expiresAt: new Date(Date.now() + days * day).toISOString(), createdBy: maxi }
      invites = [invite, ...invites]
      return { ok: true, value: { ...link(origin, days * 24 * 60), expiresAt: invite.expiresAt, invite } }
    }
    case "site.revoke-session": {
      const session = sessions.find(session => session.id === input.id)
      if (!session) return missing("browser")
      sessions = sessions.filter(other => other.id !== input.id)
      return { ok: true, value: { revoked: true, removedUser: session.kind === "guest" } }
    }
    case "site.revoke-invite": {
      if (!invites.some(invite => invite.id === input.id)) return missing("invite")
      invites = invites.filter(invite => invite.id !== input.id)
      return { ok: true, value: { revoked: true } }
    }
    default: return undefined
  }
}
