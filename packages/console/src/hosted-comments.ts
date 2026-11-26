import { eq } from "drizzle-orm"

import { readBoundedHttpBody } from "@vite-hub/internal/http-request"
import { siteAccessRoles } from "@vite-hub/internal/site-token"
import { commentsRoleAllows, defineComments } from "vite-hub/comments"
import { createCommentsHandler } from "vite-hub/comments/runtime"
import { hostedCommentNoticeRoom, hostedCommentsChangeNotice, hostedCommentsEndedNotice, hostedCommentsNoticeDefinition, installComments } from "vite-hub/comments/server"
import { isRealtimeAvailable, notifyRealtimeRoom } from "vite-hub/realtime/server"

import { consoleErrorDiagnostics } from "./error-diagnostics.ts"
import { renderHostedCommentsSignIn } from "./hosted-comments-page.ts"
import { consoleHostedCommentTables } from "./hosted-comments-schema.ts"
import {
  endHostedCommentsSession,
  hostedCommentsSession,
  hostedCommentsTokenSession,
  isHostedCommentsSecret,
  isHostedCommentsVerifier,
  issueHostedCommentsCode,
  hostedCommentsTokenSessions,
  redeemHostedCommentsCode,
} from "./hosted-comments-session.ts"
import { consoleProjects } from "./projects.ts"
import { consoleSiteGrants, createConsoleSiteStore, siteMember, sitePassCookie, sitePassSetCookie } from "./site-access.ts"

import type { Diagnostic } from "nostics"
import type { CommentAction, CommentsUser, CommentSubject, CommentThread } from "vite-hub/comments"
import type { CommentsDatabase } from "vite-hub/comments/server"
import type { RealtimePresenceDefinition } from "vite-hub/realtime"
import type { HostedCommentsHolder, HostedCommentsSessionRow } from "./hosted-comments-session.ts"
import type { ConsoleDatabase, ConsoleProject } from "./projects.ts"
import type { ConsoleSiteGrantRow } from "./site-access.ts"

interface HostedCommentsPerson {
  id: string
  name: string
  email?: string
  image?: string
  guest?: true
  roles: readonly string[]
}

type HostedProject = Pick<ConsoleProject, "id" | "url" | "teamId">

export const hostedCommentGuestRoles = siteAccessRoles.filter(role => ["comments-read", "comments-write", "comments-resolve"].includes(role.id))
const hostedCommentsRoles = hostedCommentGuestRoles.map(role => role.id)

const commentsRoute = "/_vitehub/comments"
const maximumRequestBytes = 1024 * 1024
const maximumRedeemBytes = 4 * 1024
const noStore = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" }
const people = new WeakMap<Request, CommentsUser>()
type HostedCommentsHandler = ReturnType<typeof createCommentsHandler>
const installed = new WeakMap<ConsoleDatabase, Map<string, HostedCommentsHandler>>()
const apiRoutes: readonly [string, RegExp][] = [
  ["GET", /^\/session$/],
  ["GET", /^\/threads$/],
  ["POST", /^\/threads$/],
  ["GET", /^\/scopes\/[^/]+\/threads\/\d+$/],
  ["GET", /^\/threads\/[^/]+$/],
  ["POST", /^\/threads\/[^/]+\/comments$/],
  ["POST", /^\/threads\/[^/]+\/(?:resolve|reopen)$/],
]

function mountOf(url: string): string {
  return new URL(url).pathname.replace(/\/+$/, "")
}

function onMount(mount: string, subject: CommentSubject | undefined, action: CommentAction): boolean {
  if (!subject) return action === "read"
  return subject.kind === "page" && (subject.id === mount || subject.id.startsWith(`${mount}/`))
}

function userOf(person: HostedCommentsPerson): CommentsUser {
  const { roles, ...user } = person
  return { ...user, role: roles.join(",") }
}

function hostedComments(db: ConsoleDatabase, project: Pick<ConsoleProject, "id" | "url">): HostedCommentsHandler {
  const projects = installed.get(db) ?? new Map<string, HostedCommentsHandler>()
  installed.set(db, projects)
  const cacheKey = `${project.id} ${project.url}`
  const cached = projects.get(cacheKey)
  if (cached) return cached
  const mount = mountOf(project.url)
  const comments = defineComments({
    identify: ({ event }) => event instanceof Request ? people.get(event) ?? null : null,
    authorize: ({ user, action, thread, subject }) => commentsRoleAllows(user, action) && onMount(mount, thread?.subject ?? subject, action),
  })
  // SAFETY: the Console Database is a Drizzle SQLite Database: libSQL, D1, or the Database of a ViteHub app.
  const database = db as unknown as CommentsDatabase
  installComments(comments, {
    database,
    tables: consoleHostedCommentTables,
    tenant: { tenant: project.id },
    realtime: async () => ({ notifyCommentsChange: thread => notifyHostedSessions(db, project.id, thread) }),
  })
  const handler = createCommentsHandler({ comments, realtime: isRealtimeAvailable(), attachments: false })
  projects.set(cacheKey, handler)
  return handler
}

function problem(status: number, diagnostic: Diagnostic<unknown>): Response {
  const { code, docs, fix, why } = diagnostic
  return Response.json({ error: { code, why, fix, docs } }, { status, headers: noStore })
}

function pageProblem(status: number, diagnostic: Diagnostic<unknown>): Response {
  const headers = { ...noStore, "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "x-frame-options": "DENY" }
  return new Response(`${diagnostic.why}\n\n${diagnostic.fix ?? ""}\n`, { status, headers })
}

const refused = (reason: string) => consoleErrorDiagnostics.CONSOLE_HOSTED_COMMENTS_REQUEST_REFUSED({ reason })
const notFound = () => problem(404, consoleErrorDiagnostics.CONSOLE_HOSTED_COMMENTS_NOT_FOUND())

async function projectOf(db: ConsoleDatabase, id: string): Promise<HostedProject | undefined> {
  const [project] = await db.select({ id: consoleProjects.id, url: consoleProjects.url, teamId: consoleProjects.teamId })
    .from(consoleProjects).where(eq(consoleProjects.id, id)).limit(1)
  return project
}

function projectIdOf(pathname: string, route: "authorize" | "redeem" | "api"): { id: string, rest: string } | undefined {
  const match = /^\/comments\/([^/]+)\/([^/]+)(\/.*)?$/.exec(pathname)
  if (!match || match[2] !== route || (route !== "api" && match[3])) return undefined
  try {
    return { id: decodeURIComponent(match[1]!), rest: match[3] ?? "/" }
  }
  catch {
    return undefined
  }
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=")
    if (separator !== -1 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return undefined
}

async function grantPerson(db: ConsoleDatabase, project: HostedProject, grant: ConsoleSiteGrantRow, now: number): Promise<HostedCommentsPerson | undefined> {
  if (grant.kind !== "comments" || grant.projectId !== project.id || grant.revokedAt !== null || grant.expiresAt <= now) return undefined
  if (!await siteMember(db, project, grant.createdBy)) return undefined
  const roles = hostedCommentsRoles.filter(role => grant.roles.includes(role))
  return roles.length ? { id: `guest:${grant.id}`, name: grant.name, roles, guest: true } : undefined
}

async function holderPerson(db: ConsoleDatabase, project: HostedProject, holder: HostedCommentsHolder, now: number): Promise<HostedCommentsPerson | undefined> {
  if (holder.grantId) {
    const [grant] = await db.select().from(consoleSiteGrants).where(eq(consoleSiteGrants.id, holder.grantId)).limit(1)
    return grant ? await grantPerson(db, project, grant, now) : undefined
  }
  const member = holder.userId ? await siteMember(db, project, holder.userId) : undefined
  return member && { ...member, roles: hostedCommentsRoles }
}

function fixedCodeDestination(project: HostedProject, value: string | null): URL | undefined {
  const site = new URL(project.url)
  site.search = ""
  site.hash = ""
  if (value === null) return site
  let target: URL
  try {
    target = new URL(value)
  }
  catch {
    return undefined
  }
  if (/[?#]/.test(value) || target.username || target.password) return undefined
  const path = target.pathname.replace(/\/+$/, "")
  return target.origin === site.origin && path === mountOf(project.url) ? site : undefined
}

/**
 * `GET /comments/<project>/authorize?challenge=<S256 challenge>[&return=<URL>]`: the top-level Console page that
 * signs the embed in. It finds the person: a signed-in member of the project's team (`userId`), or the Site access
 * pass cookie of the browser for the project. Then it writes a one-time code for the PKCE challenge and sends the
 * browser to `<project URL>#vhc=<code>`. A person who is not signed in gets the sign-in page.
 */
export async function authorizeHostedComments(request: Request, options: { db: ConsoleDatabase, userId?: string | null, now?: number }): Promise<Response> {
  const { db } = options
  const now = options.now ?? Date.now()
  if (request.method !== "GET") return new Response(null, { headers: { allow: "GET" }, status: 405 })
  const mode = request.headers.get("sec-fetch-mode")
  if (mode && mode !== "navigate") return pageProblem(403, refused("open the sign-in as a page of the browser, not with fetch()."))
  const url = new URL(request.url)
  const route = projectIdOf(url.pathname, "authorize")
  const project = route && await projectOf(db, route.id)
  if (!project) return pageProblem(404, consoleErrorDiagnostics.CONSOLE_HOSTED_COMMENTS_NOT_FOUND())
  const challenge = url.searchParams.get("challenge")
  if (!isHostedCommentsSecret(challenge)) return pageProblem(400, refused("`challenge` is not a PKCE S256 challenge: 43 base64url characters."))
  const target = fixedCodeDestination(project, url.searchParams.get("return"))
  if (!target) return pageProblem(400, consoleErrorDiagnostics.CONSOLE_HOSTED_COMMENTS_RETURN_INVALID({ site: project.url }))
  const headers = new Headers(noStore)
  let holder: HostedCommentsHolder | undefined
  if (options.userId && await siteMember(db, project, options.userId)) holder = { userId: options.userId, grantId: null }
  else {
    const secure = url.protocol === "https:"
    const pass = readCookie(request, sitePassCookie(project.id, secure, "comments"))
    const grant = pass ? await createConsoleSiteStore(db, project.id, "comments").pass(pass) : undefined
    if (pass && grant && await grantPerson(db, project, grant, now)) {
      holder = { userId: grant.userId, grantId: grant.id }
      headers.set("set-cookie", sitePassSetCookie(project.id, pass, secure, "comments", grant.expiresAt))
    }
  }
  if (!holder) return renderHostedCommentsSignIn({ site: new URL(project.url).host, state: options.userId ? "forbidden" : "sign-in" })
  const code = await issueHostedCommentsCode(db, { projectId: project.id, holder, challenge, now })
  target.hash = `vhc=${code}`
  headers.set("location", target.href)
  return new Response(null, { headers, status: 303 })
}

function refusedCall(request: Request, consoleOrigin: string): Response | undefined {
  if (request.headers.has("cookie")) return problem(403, refused("it carries cookies. Call the Console with `credentials: \"omit\"`."))
  const site = request.headers.get("sec-fetch-site")
  if (site && site !== "same-origin") return problem(403, refused(`it came from another origin (Sec-Fetch-Site: ${site}).`))
  const origin = request.headers.get("origin")
  if (origin !== null && origin !== consoleOrigin) return problem(403, refused(`its Origin ${origin} is not the Console.`))
  const type = request.headers.get("content-type")
  if (type !== null && !/^application\/json(?:;|$)/i.test(type)) return problem(415, refused("its body is not JSON."))
  return undefined
}

/**
 * `POST /comments/<project>/redeem` with `{ "code": "<code>", "verifier": "<PKCE verifier>" }`: the embed of the
 * Console origin uses the code of `#vhc=` once and gets `{ "token": "<bearer token>" }` for the Comments API. It needs
 * the verifier of the challenge, so only the embed that started the sign-in gets the token.
 */
export async function redeemHostedComments(request: Request, options: { db: ConsoleDatabase, now?: number }): Promise<Response> {
  const { db } = options
  const now = options.now ?? Date.now()
  if (request.method !== "POST") return new Response(null, { headers: { allow: "POST" }, status: 405 })
  const url = new URL(request.url)
  const route = projectIdOf(url.pathname, "redeem")
  if (!route) return notFound()
  const blocked = refusedCall(request, url.origin)
  if (blocked) return blocked
  if (request.headers.get("content-type") === null) return problem(415, refused("its body is not JSON."))
  const body = await readBoundedHttpBody(request, maximumRedeemBytes)
  if (!body) return problem(413, refused("its body exceeds 4 KiB."))
  let input: unknown
  try {
    input = JSON.parse(new TextDecoder().decode(body))
  }
  catch {
    input = undefined
  }
  const code: unknown = input instanceof Object ? Reflect.get(input, "code") : undefined
  const verifier: unknown = input instanceof Object ? Reflect.get(input, "verifier") : undefined
  if (!isHostedCommentsSecret(code) || !isHostedCommentsVerifier(verifier)) return problem(400, refused("send { \"code\": \"<code of #vhc>\", \"verifier\": \"<PKCE verifier>\" }."))
  const project = await projectOf(db, route.id)
  if (!project) return notFound()
  const redeemed = await redeemHostedCommentsCode(db, { projectId: project.id, code, verifier, now })
  if (!redeemed) return problem(400, consoleErrorDiagnostics.CONSOLE_HOSTED_COMMENTS_CODE_INVALID())
  if (!await holderPerson(db, project, redeemed.session, now)) {
    await endHostedCommentsSession(db, redeemed.session.id)
    return problem(403, consoleErrorDiagnostics.CONSOLE_HOSTED_COMMENTS_ACCESS_ENDED())
  }
  return Response.json({ token: redeemed.token }, { headers: noStore })
}

async function liveSession(db: ConsoleDatabase, project: HostedProject, request: Request, now: number): Promise<{ session: HostedCommentsSessionRow, person: HostedCommentsPerson } | Response> {
  const token = /^Bearer ([\w-]+)$/.exec(request.headers.get("authorization") ?? "")?.[1]
  if (!isHostedCommentsSecret(token)) return problem(401, consoleErrorDiagnostics.CONSOLE_HOSTED_COMMENTS_TOKEN_INVALID())
  const session = await hostedCommentsSession(db, { projectId: project.id, token, now })
  if (!session) return problem(401, consoleErrorDiagnostics.CONSOLE_HOSTED_COMMENTS_TOKEN_INVALID())
  const person = await holderPerson(db, project, session, now)
  if (person) return { session, person }
  await endHostedCommentsSession(db, session.id)
  return problem(403, consoleErrorDiagnostics.CONSOLE_HOSTED_COMMENTS_ACCESS_ENDED())
}

/**
 * `/comments/<project>/api/<route>`: the Comments API of the project for the embed, such as `GET …/api/session` and
 * `POST …/api/threads`. Each call is a same-origin call of the Console with `Authorization: Bearer <token>` from
 * `redeem`, without cookies, and with a JSON body. Each call checks the token, the project, and the membership or the
 * pass again. Only the routes of the overlay answer, and threads stay on pages under the URL of the project.
 */
export async function handleHostedCommentsApi(request: Request, options: { db: ConsoleDatabase, now?: number }): Promise<Response> {
  const { db } = options
  const now = options.now ?? Date.now()
  const url = new URL(request.url)
  const route = projectIdOf(url.pathname, "api")
  if (!route) return notFound()
  const path = route.rest.replace(/\/+$/, "") || "/"
  if (!apiRoutes.some(([method, pattern]) => method === request.method && pattern.test(path))) {
    return problem(404, consoleErrorDiagnostics.CONSOLE_HOSTED_COMMENTS_NOT_FOUND())
  }
  const blocked = refusedCall(request, url.origin)
  if (blocked) return blocked
  const project = await projectOf(db, route.id)
  if (!project) return notFound()
  const live = await liveSession(db, project, request, now)
  if (live instanceof Response) return live
  const user = userOf(live.person)
  const body = await readBoundedHttpBody(request, maximumRequestBytes)
  if (!body) return problem(413, refused("its body exceeds 1 MiB."))
  const site = new URL(project.url)
  const forwarded = new Request(`${site.origin}${mountOf(project.url)}${commentsRoute}${path === "/" ? "" : path}${url.search}`, {
    method: request.method,
    ...(body.byteLength ? { body, headers: { "content-type": "application/json" } } : {}),
  })
  people.set(forwarded, user)
  const response = await hostedComments(db, project).fetch(forwarded)
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(noStore)) headers.set(name, value)
  return new Response(response.body, { headers, status: response.status, statusText: response.statusText })
}

function roomProjectId(documentId: string | null): string | undefined {
  const match = documentId === null ? null : /^projects\/([^/]+)$/.exec(documentId)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1]!)
  }
  catch {
    return undefined
  }
}

async function mayRead(db: ConsoleDatabase, project: HostedProject, session: HostedCommentsSessionRow, now: number): Promise<boolean | undefined> {
  const person = await holderPerson(db, project, session, now)
  return person && commentsRoleAllows(userOf(person), "read")
}

async function notifyHostedSessions(db: ConsoleDatabase, projectId: string, thread: Pick<CommentThread, "subject">): Promise<void> {
  const now = Date.now()
  const project = await projectOf(db, projectId)
  if (!project) return
  const room = hostedCommentNoticeRoom(project.id)
  await Promise.all((await hostedCommentsTokenSessions(db, project.id)).map(async (session) => {
    const reads = session.expiresAt > now ? await mayRead(db, project, session, now) : undefined
    if (reads) return await notifyRealtimeRoom(hostedCommentsNoticeDefinition, room, hostedCommentsChangeNotice(thread.subject), { user: session.id })
    if (reads !== undefined) return
    await endHostedCommentsSession(db, session.id)
    await notifyRealtimeRoom(hostedCommentsNoticeDefinition, room, hostedCommentsEndedNotice, { user: session.id })
  }))
}

const joiningSessions = new WeakMap<Request, HostedCommentsSessionRow>()

/**
 * The Realtime Definition of the notice rooms of Hosted Comments sites. Each project has one room, named by
 * `hostedCommentNoticeRoom()`, and each session of the project has its own copy of it. The embed frame joins with its
 * token in `?token=`. Only a live token of the project of the room, whose holder may read comments, joins it. The rooms
 * hold no document and no presence: only the server sends to them, after each change of a thread. Before each notice it
 * checks the expiry and the pass or the membership of each session again. It ends a session that expired or lost
 * access and sends it `{ type: "ended" }` instead, so its page closes the socket and drops the token.
 */
export function hostedCommentsRealtime(database: () => ConsoleDatabase, options: { now?: () => number } = {}): RealtimePresenceDefinition {
  const now = () => options.now?.() ?? Date.now()
  return {
    document: false,
    awareness: false,
    scope: "user",
    async identify({ request }) {
      const token = new URL(request.url).searchParams.get("token")
      const session = isHostedCommentsSecret(token) ? await hostedCommentsTokenSession(database(), { token, now: now() }) : undefined
      if (!session) return null
      joiningSessions.set(request, session)
      return { id: session.id }
    },
    async authorize({ documentId, mode, request, user }) {
      const session = joiningSessions.get(request)
      if (mode !== "read" || !session || user?.id !== session.id || roomProjectId(documentId) !== session.projectId) return false
      const db = database()
      const project = await projectOf(db, session.projectId)
      return project !== undefined && await mayRead(db, project, session, now()) === true
    },
  }
}
