import { eq } from "drizzle-orm"
import { withAnonymousAuthorization } from "vite-hub/auth/server"
import { useDatabase } from "vite-hub/database"

import { normalizeConsoleProjectUrl } from "@vite-hub/runtime/internal/console"
import { isSitePath, isSiteStateHash, siteAccessRoles, siteRoute } from "@vite-hub/internal/site-token"

import { consoleProjects } from "../../src/projects.ts"
import {
  createConsoleSiteStore,
  openConsoleSiteLink,
  readGuestRoles,
  siteGuestNameLength,
  siteInviteDays,
  siteMember,
  sitePassCookie,
  sitePassPerson,
  sitePassSetCookie,
  siteTeamMembers,
  siteTokenLocation,
} from "../../src/site-access.ts"
import { consoleJson, consoleProblem, projectNotFound, useConsoleProjects } from "./console.ts"

import type { ConsoleProject } from "../../src/projects.ts"
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

async function signingTarget(project: Pick<ConsoleProject, "id" | "teamId">) {
  const projects = useConsoleProjects(project.teamId)
  return projects instanceof Response ? undefined : await projects.target(project.id)
}

function openPage(app: string, path: string, state: string): string {
  return `/open?${new URLSearchParams({ project: app, site: path, visit: state })}`
}

export const siteVisitRoute = withAnonymousAuthorization(() => true, async (request: Request, authorization) => {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { headers: { allow: "GET, HEAD" }, status: 405 })
  const query = new URL(request.url).searchParams
  const app = normalizeConsoleProjectUrl(query.get("app") ?? "")
  const state = query.get("state") ?? ""
  const path = query.get("return") || "/"
  if (!app || !isSiteStateHash(state) || !isSitePath(path)) return linkProblem(400, "This Site access link is malformed. Open the site again.")
  const db = useDatabase("default").db
  const projects = await db.select({ id: consoleProjects.id, teamId: consoleProjects.teamId }).from(consoleProjects).where(eq(consoleProjects.url, app))
  const secure = isSecure(request)
  for (const project of projects) {
    const pass = readCookie(request, sitePassCookie(project.id, secure))
    const grant = pass ? await createConsoleSiteStore(db, project.id).pass(pass) : undefined
    const signedIn = grant ? await sitePassPerson(db, project, grant) : undefined
    const person = signedIn ?? (authorization.user ? await siteMember(db, project, authorization.user.id) : undefined)
    if (!person) continue
    const target = await signingTarget(project)
    if (!target) continue
    const headers = new Headers()
    if (grant && pass) headers.append("set-cookie", sitePassSetCookie(project.id, pass, secure))
    return seeOther(await siteTokenLocation({ project: target.project, key: target.key, ...person, state, path }), headers)
  }
  return seeOther(openPage(app, path, state))
})

export async function openSiteLink(request: Request, kind: "invite" | "code"): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { headers: { allow: "GET" }, status: 405 })
  const secret = decodeURIComponent(new URL(request.url).pathname.split("/")[2] ?? "")
  const db = useDatabase("default").db
  const what = kind === "invite" ? "invite" : "code"
  if (!/^[\w-]{43}$/.test(secret)) return linkProblem(404, `There is no such ${what}.`)
  const opened = await openConsoleSiteLink(db, kind, secret, request.headers.get("user-agent") ?? "")
  const [project] = opened ? await db.select().from(consoleProjects).where(eq(consoleProjects.id, opened.projectId)).limit(1) : []
  if (opened && project) {
    if (opened.grant.kind === "member" && !await sitePassPerson(db, project, opened.grant)) return linkProblem(403, "This code belongs to a person who is no longer a member of the team.")
    const headers = new Headers()
    headers.append("set-cookie", sitePassSetCookie(project.id, opened.pass, isSecure(request)))
    return seeOther(`${project.url}${siteRoute}?${new URLSearchParams({ return: opened.path })}`, headers)
  }
  return linkProblem(410, `This ${what} was already opened, revoked, or it expired. Ask for a new one.`)
}

function pathOf(value: unknown): string | undefined {
  if (value === undefined) return "/"
  return typeof value === "string" && isSitePath(value) ? value : undefined
}

function nameOf(caller: ConsoleTeamCaller): string {
  return caller.user.name ?? caller.user.email ?? "Console member"
}

export async function consoleSiteRoute(request: Request, caller: ConsoleTeamCaller): Promise<Response> {
  const url = new URL(request.url)
  const match = /^\/api\/projects\/([^/]+)\/site(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/.exec(url.pathname)
  if (!match) return consoleProblem(404, "NOT_FOUND", "Not found.")
  const [, rawId, section = "", rawItem] = match
  const project = await caller.projects.get(decodeURIComponent(rawId!))
  if (!project) return projectNotFound()
  const db = useDatabase("default").db
  const store = createConsoleSiteStore(db, project.id)
  const item = rawItem ? decodeURIComponent(rawItem) : undefined
  const route = `${request.method} ${section}${item ? "/:item" : ""}`
  const body: unknown = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
  const origin = url.origin
  switch (route) {
    case "GET ":
      return consoleJson({ members: await siteTeamMembers(db, project.teamId), sessions: await store.sessions(), invites: await store.invites(), grants: siteAccessRoles })
    case "POST invites": {
      const name = field(body, "name")
      const grants = field(body, "grants")
      const days = field(body, "expiresInDays") ?? 7
      const path = pathOf(field(body, "path"))
      if (typeof name !== "string" || !name.trim() || name.trim().length > siteGuestNameLength) return consoleProblem(400, "CONSOLE_SITE_INVITE_INVALID", `Give the guest a name of 1 to ${siteGuestNameLength} characters. It is the author of their comments.`)
      if (!Array.isArray(grants) || !grants.every(grant => typeof grant === "string")) return consoleProblem(400, "CONSOLE_SITE_INVITE_INVALID", "Send the roles of the guest as \"grants\", such as [\"comments-write\"].")
      if (!siteInviteDays.some(allowed => allowed === days)) return consoleProblem(400, "CONSOLE_SITE_INVITE_INVALID", `An invite lasts ${siteInviteDays.join(", ")} days.`)
      if (!path) return consoleProblem(400, "CONSOLE_SITE_INVITE_INVALID", "Use a path of the app, such as /runs/42.")
      const roles = readGuestRoles(grants.filter(grant => typeof grant === "string"))
      if ("error" in roles) return consoleProblem(400, "CONSOLE_SITE_INVITE_INVALID", roles.error)
      const { secret, invite } = await store.invite({ name: name.trim(), roles, days: Number(days), path, createdBy: { id: caller.user.id, name: nameOf(caller) } })
      return consoleJson({ url: `${origin}/i/${secret}`, expiresAt: invite.expiresAt, invite }, 201)
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
      return revoked ? consoleJson({ revoked: true, removedUser: revoked.kind === "guest" }) : consoleProblem(404, "CONSOLE_SITE_SESSION_NOT_FOUND", "No browser has this pass. It was revoked, or it expired.")
    }
    case "POST token": {
      const path = pathOf(field(body, "path"))
      const state = field(body, "state")
      if (!path || typeof state !== "string" || !isSiteStateHash(state)) return consoleProblem(400, "CONSOLE_SITE_TOKEN_INVALID", "Send { \"path\": \"/docs\", \"state\": \"<the state hash of the app>\" }.")
      const person = await siteMember(db, project, caller.user.id)
      if (!person) return consoleProblem(403, "CONSOLE_SITE_FORBIDDEN", "Only members of the team open the site from the Console.")
      const target = await caller.projects.target(project.id)
      if (!target) return projectNotFound()
      return consoleJson({ url: await siteTokenLocation({ project: target.project, key: target.key, ...person, state, path }) })
    }
    default:
      return consoleProblem(404, "NOT_FOUND", "Not found.")
  }
}
