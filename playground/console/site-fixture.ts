import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin } from "vite"

import { readSiteTokenTarget, siteActionOperation } from "../../packages/internal/src/site-token.ts"
import type { SiteGrant, SiteInvite, SiteSession } from "../../packages/vite-hub/src/console/runtime/client/site-access.ts"
import { authFixture } from "./auth-fixture.ts"

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
const route = /^\/api\/projects\/[^/]*\/site(?:\/(codes|invites|sessions|open)(?:\/([^/]+))?)?$/

function link(origin: string, minutes: number): { url: string, expiresAt: string } {
  return { url: `${origin}/go/playground${String(next++).padStart(8, "0")}`, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader("cache-control", "no-store")
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = ""
  for await (const chunk of request) text += String(chunk)
  const value: unknown = text ? JSON.parse(text) : {}
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

async function answer(request: IncomingMessage, origin: string, collection: string | undefined, id: string | undefined): Promise<[number, unknown]> {
  if (request.method === "GET" && !collection) return [200, { sessions, invites, grants }]
  if (request.method === "POST" && collection === "codes" && !id) return [200, link(origin, 10)]
  if (request.method === "POST" && collection === "open" && !id) {
    if (request.headers["content-type"]?.split(";")[0] !== "application/json") return [415, { message: "Send a JSON request." }]
    if (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin") return [403, { message: "Start the action from the playground." }]
    const { kind, target: value } = await readJson(request)
    const target = readSiteTokenTarget(value)
    const action = kind === "impersonate" && target ? siteActionOperation(kind, target) : undefined
    if (!target || !action) return [400, { message: "Start or stop an impersonation." }]
    authFixture({ ...action.input, action: target.action === "start" ? "impersonate" : "stopImpersonating" }, process.env.VITEHUB_PLAYGROUND_AUTH_EVENTS !== "off")
    return [201, { url: "/", expiresAt: new Date(Date.now() + 60_000).toISOString() }]
  }
  if (request.method === "POST" && collection === "invites" && !id) {
    const input = await readJson(request)
    const days = Number(input.expiresInDays ?? 7)
    const invite: SiteInvite = { id: `invite-${next}`, name: String(input.name ?? ""), grants: Array.isArray(input.grants) ? input.grants.map(String) : [], path: "/", expiresAt: new Date(Date.now() + days * day).toISOString(), createdBy: maxi }
    invites = [invite, ...invites]
    return [200, { ...link(origin, days * 24 * 60), expiresAt: invite.expiresAt, invite }]
  }
  if (request.method === "DELETE" && collection === "sessions" && id) {
    if (!sessions.some(session => session.id === id)) return [404, { message: "No browser has this id." }]
    sessions = sessions.filter(session => session.id !== id)
    return [200, { revoked: true }]
  }
  if (request.method === "DELETE" && collection === "invites" && id) {
    if (!invites.some(invite => invite.id === id)) return [404, { message: "No invite has this id." }]
    invites = invites.filter(invite => invite.id !== id)
    return [200, { revoked: true }]
  }
  return [405, { message: "The playground does not answer this Site access request." }]
}

export function consoleMockSite(): Plugin {
  return {
    name: "vitehub-console-playground-site",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match = route.exec(request.url?.split("?")[0] ?? "")
        if (!match) {
          next()
          return
        }
        const origin = `http://${request.headers.host ?? "localhost"}`
        void answer(request, origin, match[1], match[2] === undefined ? undefined : decodeURIComponent(match[2]))
          .then(([status, body]) => send(response, status, body))
          .catch(next)
      })
    },
  }
}
