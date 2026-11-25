import { eq } from "drizzle-orm"
import { withAnonymousAuthorization } from "vite-hub/auth/server"
import { useDatabase } from "vite-hub/database"

import { isRuntimeDiagnostic } from "@vite-hub/runtime"
import { normalizeConsoleProjectUrl } from "@vite-hub/runtime/internal/console"
import { isSitePath, isSiteStateHash, readSiteAccessPolicy, signSiteHandoff, siteAccessOperation, siteAccessRoles } from "@vite-hub/internal/site-token"

import { consoleProjects } from "../../src/projects.ts"
import { hostedCommentGuestRoles } from "../../src/hosted-comments.ts"
import {
  createConsoleSiteStore,
  openConsoleSiteLink,
  readGuestRoles,
  siteConsoleRole,
  siteGuestNameLength,
  siteInviteDays,
  siteMember,
  siteMemberRoles,
  sitePassCookie,
  sitePassSetCookie,
  siteTokenLocation,
} from "../../src/site-access.ts"
import { callProjectOperation, canManageProjects, consoleCallerUser, consoleJson, consoleProblem, consoleTeamCaller, projectNotFound, useConsoleProjects } from "./console.ts"

import type { SiteAccessPolicy } from "@vite-hub/internal/site-token"
import type { ConsoleSiteGrantRow, ConsoleSitePerson } from "../../src/site-access.ts"
import type { ConsoleTeamCaller } from "./console.ts"

const noStore = { "cache-control": "no-store", "referrer-policy": "no-referrer" }

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:"
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=")
    if (separator !== -1 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return undefined
}

function seeOther(location: string, headers = new Headers()): Response {
  headers.set("location", location)
  for (const [name, value] of Object.entries(noStore)) headers.set(name, value)
  return new Response(null, { headers, status: 303 })
}

function linkProblem(status: number, message: string): Response {
  return new Response(`${message}\n`, { headers: { ...noStore, "content-type": "text/plain; charset=utf-8" }, status })
}

function field(body: unknown, name: string): unknown {
  return body instanceof Object ? Reflect.get(body, name) : undefined
}

async function sitePolicy(caller: ConsoleTeamCaller, projectId: string, write: boolean): Promise<SiteAccessPolicy | Response> {
  const result = await callProjectOperation(caller, projectId, siteAccessOperation, {})
  if (!result) return projectNotFound()
  if (!result.ok) {
    const status = result.status === 429 ? 429 : result.status >= 500 ? 502 : 403
    return consoleProblem(status, result.error.code ?? "CONSOLE_SITE_FORBIDDEN", `The app refused Site access: ${result.error.message}`)
  }
  const policy = readSiteAccessPolicy(result.value)
  if (!policy) return consoleProblem(502, "CONSOLE_SITE_POLICY_INVALID", `The app answered ${siteAccessOperation} without { "write": boolean, "roles": [...] }.`)
  if (write && !policy.write) return consoleProblem(403, "CONSOLE_SITE_FORBIDDEN", "The app gives you read-only Site access.")
  return policy
}

async function signedLocation(input: Parameters<typeof siteTokenLocation>[0]): Promise<string | Response> {
  try {
    return await siteTokenLocation(input)
  }
  catch (error) {
    if (isRuntimeDiagnostic(error) && error.code === "INTERNAL_SITE_TOKEN_TOO_LONG") return consoleProblem(400, "CONSOLE_SITE_TOKEN_INVALID", error.message)
    throw error
  }
}

async function memberPolicy(project: { id: string, teamId: string }, userId: string): Promise<{ person: ConsoleSitePerson, policy: SiteAccessPolicy } | undefined> {
  const person = await siteMember(useDatabase("default").db, project, userId)
  const caller = person ? await consoleTeamCaller(consoleCallerUser({ id: userId, name: person.name }), project.teamId) : undefined
  if (!person || !caller || caller instanceof Response) return undefined
  const policy = await sitePolicy(caller, project.id, true)
  return policy instanceof Response ? undefined : { person, policy }
}

async function memberAccess(project: { id: string, teamId: string }, userId: string): Promise<{ person: ConsoleSitePerson, roles: string[] } | undefined> {
  const member = await memberPolicy(project, userId)
  return member && { person: member.person, roles: siteMemberRoles(member.policy) }
}

async function guestRoles(project: { id: string, teamId: string }, inviter: string, roles: readonly string[]): Promise<string[]> {
  const policy = (await memberPolicy(project, inviter))?.policy
  const allowed = new Set(policy?.roles.filter(role => !role.membersOnly).map(role => role.id))
  return roles.filter(role => allowed.has(role))
}

async function guestAccess(project: { id: string, teamId: string }, grant: ConsoleSiteGrantRow): Promise<{ person: ConsoleSitePerson, roles: string[] } | undefined> {
  const roles = await guestRoles(project, grant.createdBy, grant.roles)
  return roles.length ? { person: { id: `site-guest:${grant.id}`, name: grant.name }, roles } : undefined
}

async function visitLocation(project: { id: string, teamId: string }, access: { person: ConsoleSitePerson, roles: string[] }, state: string, path: string, headers = new Headers()): Promise<Response | undefined> {
  const projects = useConsoleProjects(project.teamId)
  const target = projects instanceof Response ? undefined : await projects.target(project.id)
  if (!target) return undefined
  const location = await signedLocation({ project: target.project, key: target.key, ...access, state, path })
  return location instanceof Response ? location : seeOther(location, headers)
}

export const siteVisitRoute = withAnonymousAuthorization(() => true, async (request: Request, authorization) => {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { headers: { allow: "GET, HEAD" }, status: 405 })
  const query = new URL(request.url).searchParams
  const app = normalizeConsoleProjectUrl(query.get("app") ?? "")
  const state = query.get("state") ?? ""
  const path = query.get("return") || "/"
  const only = query.get("project")
  if (!app || !isSiteStateHash(state) || !isSitePath(path)) return linkProblem(400, "This Site access link is malformed. Open the site again.")
  const db = useDatabase("default").db
  const projects = (await db.select({ id: consoleProjects.id, teamId: consoleProjects.teamId }).from(consoleProjects).where(eq(consoleProjects.url, app)))
    .filter(project => !only || project.id === only)
  const secure = isSecure(request)
  for (const project of projects) {
    const pass = readCookie(request, sitePassCookie(project.id, secure))
    const grant = pass ? await createConsoleSiteStore(db, project.id).pass(pass) : undefined
    if (!grant || !pass) continue
    const access = grant.kind === "guest" ? await guestAccess(project, grant) : grant.userId ? await memberAccess(project, grant.userId) : undefined
    if (!access) continue
    const visited = await visitLocation(project, access, state, path, new Headers({ "set-cookie": sitePassSetCookie(project.id, pass, secure) }))
    if (visited?.status === 303) await createConsoleSiteStore(db, project.id).issued(grant.id, access.roles)
    if (visited) return visited
  }
  const userId = authorization.user?.id
  for (const project of projects) {
    const access = userId ? await memberAccess(project, userId) : undefined
    const visited = access ? await visitLocation(project, access, state, path) : undefined
    if (visited) return visited
  }
  return seeOther(`/open?${new URLSearchParams({ project: app, site: path, visit: state, ...(only ? { app: only } : {}) })}`)
})

export async function openSiteLink(request: Request, kind: "invite" | "code" | "comments"): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { headers: { allow: "GET" }, status: 405 })
  const url = new URL(request.url)
  const secret = url.pathname.split("/")[kind === "comments" ? 3 : 2] ?? ""
  const db = useDatabase("default").db
  const what = kind === "code" ? "code" : "invite"
  if (!/^[\w-]{43}$/.test(secret)) return linkProblem(404, `There is no such ${what}.`)
  let handoff: string | undefined
  let handoffUnavailable = false
  const opened = await openConsoleSiteLink(db, {
    kind,
    secret,
    userAgent: request.headers.get("user-agent") ?? "",
    allow: async (link) => {
      const project = { id: link.projectId, teamId: link.teamId }
      if (link.kind === "comments") return Boolean(await siteMember(db, project, link.createdBy))
      const allowed = link.kind === "invite"
        ? (await guestRoles(project, link.createdBy, link.roles ?? [])).length > 0
        : link.userId !== null && Boolean(await memberAccess(project, link.userId))
      if (!allowed) return false
      const projects = useConsoleProjects(project.teamId)
      const target = projects instanceof Response ? undefined : await projects.target(project.id)
      handoff = target && await signSiteHandoff({ app: target.project.url, issuer: url.origin, project: project.id, path: link.path, key: target.key })
      handoffUnavailable = handoff === undefined
      return !handoffUnavailable
    },
  })
  if (handoffUnavailable) return linkProblem(503, "The Console cannot start this Site access visit. Ask the Console operator to check the project link and Console origin.")
  if (opened === "forbidden") return linkProblem(403, `The person of this ${what} can no longer give access to this site from the Console.`)
  if (opened && handoff) {
    return seeOther(handoff, new Headers({ "set-cookie": sitePassSetCookie(opened.projectId, opened.pass, isSecure(request)) }))
  }
  const [project] = opened ? await db.select().from(consoleProjects).where(eq(consoleProjects.id, opened.projectId)).limit(1) : []
  if (opened && project) {
    const destination = new URL(project.url)
    destination.searchParams.set("comment", "")
    return seeOther(destination.href, new Headers({ "set-cookie": sitePassSetCookie(project.id, opened.pass, isSecure(request), "comments", opened.expiresAt) }))
  }
  return linkProblem(410, `This ${what} was already opened, revoked, or it expired. Ask for a new one.`)
}

const siteRoutes = new Set(["GET ", "POST invites", "DELETE invites/:item", "POST codes", "DELETE sessions/:item", "POST token"])

function pathOf(value: unknown): string | undefined {
  if (value === undefined) return "/"
  return typeof value === "string" && isSitePath(value) ? value : undefined
}

function nameOf(caller: ConsoleTeamCaller): string {
  return caller.user.name ?? caller.user.email ?? "Console member"
}

export async function consoleSiteRoute(request: Request, caller: ConsoleTeamCaller): Promise<Response> {
  const url = new URL(request.url)
  const match = /^\/api\/projects\/([^/]+)\/(site|comments-access)(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/.exec(url.pathname)
  if (!match) return consoleProblem(404, "NOT_FOUND", "Not found.")
  const [, rawId, surface, section = "", rawItem] = match
  const hosted = surface === "comments-access"
  const item = rawItem ? decodeURIComponent(rawItem) : undefined
  const route = `${request.method} ${section}${item ? "/:item" : ""}`
  if (!siteRoutes.has(route)) return consoleProblem(404, "NOT_FOUND", "Not found.")
  if (hosted && (route === "POST codes" || route === "POST token")) return consoleProblem(404, "NOT_FOUND", "Not found.")
  const project = await caller.projects.get(decodeURIComponent(rawId!))
  if (!project) return projectNotFound()
  if (hosted && route !== "GET " && !canManageProjects(caller)) return consoleProblem(403, "CONSOLE_SITE_FORBIDDEN", "Only owners and admins of the team invite and remove Comments guests.")
  const policy: SiteAccessPolicy | Response = hosted ? { write: true, roles: hostedCommentGuestRoles } : await sitePolicy(caller, project.id, route !== "GET ")
  if (policy instanceof Response) return policy
  const db = useDatabase("default").db
  const store = createConsoleSiteStore(db, project.id, hosted ? "comments" : "site")
  const body: unknown = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
  const origin = url.origin
  switch (route) {
    case "GET ": {
      const consoleRole = hosted ? [] : siteAccessRoles.filter(role => role.id === siteConsoleRole)
      return consoleJson({ sessions: await store.sessions(), invites: await store.invites(), grants: [...consoleRole, ...policy.roles.filter(role => role.id !== siteConsoleRole)] })
    }
    case "POST invites": {
      const name = field(body, "name")
      const grants = field(body, "grants")
      const days = field(body, "expiresInDays") ?? 7
      const path = hosted ? "/" : pathOf(field(body, "path"))
      if (typeof name !== "string" || !name.trim() || name.trim().length > siteGuestNameLength) return consoleProblem(400, "CONSOLE_SITE_INVITE_INVALID", `Give the guest a name of 1 to ${siteGuestNameLength} characters. It is the author of their comments.`)
      if (!Array.isArray(grants) || !grants.every(grant => typeof grant === "string")) return consoleProblem(400, "CONSOLE_SITE_INVITE_INVALID", "Send the roles of the guest as \"grants\", such as [\"comments-write\"].")
      if (!siteInviteDays.some(allowed => allowed === days)) return consoleProblem(400, "CONSOLE_SITE_INVITE_INVALID", `An invite lasts ${siteInviteDays.join(", ")} days.`)
      if (!path) return consoleProblem(400, "CONSOLE_SITE_INVITE_INVALID", "Use a path of the app, such as /runs/42.")
      const roles = readGuestRoles(grants.filter(grant => typeof grant === "string"), policy)
      if ("error" in roles) return consoleProblem(400, "CONSOLE_SITE_INVITE_INVALID", roles.error)
      const { secret, invite } = await store.invite({ name: name.trim(), roles, days: Number(days), path, createdBy: { id: caller.user.id, name: nameOf(caller) } })
      return consoleJson({ url: `${origin}${hosted ? "/comments/invite" : "/i"}/${secret}`, expiresAt: invite.expiresAt, invite }, 201)
    }
    case "DELETE invites/:item":
      return await store.revokeInvite(item!) ? consoleJson({ revoked: true }) : consoleProblem(404, "CONSOLE_SITE_INVITE_NOT_FOUND", "No open invite has this id. It was opened, revoked, or it expired.")
    case "POST codes": {
      const path = pathOf(field(body, "path"))
      if (!path) return consoleProblem(400, "CONSOLE_SITE_CODE_INVALID", "Use a path of the app, such as /runs/42.")
      const code = await store.code({ userId: caller.user.id, path, createdBy: { id: caller.user.id, name: nameOf(caller) } })
      return consoleJson({ url: `${origin}/go/${code.secret}`, expiresAt: code.expiresAt }, 201)
    }
    case "DELETE sessions/:item": {
      const revoked = await store.revoke(item!)
      return revoked ? consoleJson({ revoked: true, ...(!hosted ? { removedUser: revoked.kind === "guest" } : {}) }) : consoleProblem(404, "CONSOLE_SITE_SESSION_NOT_FOUND", "No browser has this pass. It was revoked, or it expired.")
    }
    case "POST token": {
      const path = pathOf(field(body, "path"))
      const state = field(body, "state")
      if (!path || typeof state !== "string" || !isSiteStateHash(state)) return consoleProblem(400, "CONSOLE_SITE_TOKEN_INVALID", "Send { \"path\": \"/docs\", \"state\": \"<the state hash of the app>\" }.")
      const person = await siteMember(db, project, caller.user.id)
      if (!person) return consoleProblem(403, "CONSOLE_SITE_FORBIDDEN", "Only members of the team open the site from the Console.")
      const target = await caller.projects.target(project.id)
      if (!target) return projectNotFound()
      const location = await signedLocation({ project: target.project, key: target.key, person, roles: siteMemberRoles(policy), state, path })
      return location instanceof Response ? location : consoleJson({ url: location })
    }
    default:
      return consoleProblem(404, "NOT_FOUND", "Not found.")
  }
}
