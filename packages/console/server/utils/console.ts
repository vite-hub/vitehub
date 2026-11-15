import { and, desc, eq, isNotNull } from "drizzle-orm"
import { authSqliteSchema } from "vite-hub/auth/schema"
import { withAuthorization } from "vite-hub/auth/server"
import { useDatabase } from "vite-hub/database"

import { callOperationRpc, operationRpcPath } from "@vite-hub/internal/operation-rpc"

import { forwardProjectRequest } from "../../src/forward.ts"
import { consoleCallerOf, consoleCallerUser, type ConsoleCallOptions } from "../../src/caller.ts"
import { createConsoleProjectStore } from "../../src/projects.ts"
import { allowPrivateVariable, parseProjectUrl } from "../../src/project-url.ts"
import { consoleSecretProblem, consoleSecretVariable } from "../../src/token-box.ts"

import type { ConsoleCallerUser } from "@vite-hub/internal/console-signature"
import type { ConsoleProjectStore } from "../../src/projects.ts"

export { consoleCallerOf, consoleCallerUser, type ConsoleCallOptions } from "../../src/caller.ts"

const { member, organization, session } = authSqliteSchema

export function consoleProblem(status: number, code: string, message: string): Response {
  return Response.json({ code, message, ok: false, status }, { headers: { "cache-control": "no-store" }, status })
}

export function consoleJson(value: unknown, status = 200): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" }, status })
}

/** The caller of a team route: the person, their team, their role in it, and the projects of that team. */
export interface ConsoleTeamCaller {
  user: ConsoleCallerUser
  teamId: string
  /** Better Auth roles, such as `owner`, `admin`, or `member`. A member can have several, with commas between them. */
  roles: string[]
  projects: ConsoleProjectStore
}

/** Owners and admins link and unlink projects. Every member opens them. */
export function canManageProjects(caller: ConsoleTeamCaller): boolean {
  return caller.roles.includes("owner") || caller.roles.includes("admin")
}

/** The caller in a team, or `403` when the person is not a member of it. */
export async function consoleTeamCaller(user: ConsoleCallerUser, teamId: string): Promise<ConsoleTeamCaller | Response> {
  const userId = user.id
  const { db } = useDatabase("default")
  const [membership] = teamId
    ? await db.select({ role: member.role }).from(member).where(and(eq(member.organizationId, teamId), eq(member.userId, userId))).limit(1)
    : []
  if (!membership) return consoleProblem(403, "CONSOLE_TEAM_REQUIRED", "Choose a team that you are a member of.")
  const projects = useConsoleProjects(teamId)
  if (projects instanceof Response) return projects
  return { projects, roles: String(membership.role).split(",").map(role => role.trim()), teamId, user }
}

/**
 * A route that runs its handler for a signed-in member of the session's active team. Others get `401`, or `403` when
 * the session has no team or the person left it.
 */
export function consoleTeamRoute(handler: (request: Request, caller: ConsoleTeamCaller) => Promise<Response>): { fetch(request: Request): Promise<Response> } {
  return {
    fetch: withAuthorization(true, async (request, authorization) => {
      const active: unknown = Reflect.get(authorization.session, "activeOrganizationId")
      const caller = await consoleTeamCaller(consoleCallerUser(authorization.user), typeof active === "string" ? active : "")
      return caller instanceof Response ? caller : handler(request, caller)
    }),
  }
}

/**
 * The team that an MCP client of a person acts on: the team that the person opened last in the Console, else their
 * first team. An access token has no session of its own, so the newest session of the person names the team.
 */
export async function consoleActiveTeam(userId: string): Promise<{ id: string, name: string } | undefined> {
  const { db } = useDatabase("default")
  const [opened] = await db.select({ id: organization.id, name: organization.name }).from(session)
    .innerJoin(member, and(eq(member.organizationId, session.activeOrganizationId), eq(member.userId, userId)))
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(session.userId, userId), isNotNull(session.activeOrganizationId)))
    .orderBy(desc(session.updatedAt))
    .limit(1)
  const [team] = opened ? [opened] : await db.select({ id: organization.id, name: organization.name }).from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(member.createdAt)
    .limit(1)
  return team ? { id: String(team.id), name: String(team.name) } : undefined
}

/** The project id in a route path, such as `<id>` in `/api/projects/<id>/check` or `/p/<id>/_vitehub/...`. */
export function projectIdOf(request: Request, prefix: "/api/projects/" | "/p/"): string {
  const path = new URL(request.url).pathname
  const start = path.indexOf(prefix)
  return start === -1 ? "" : decodeURIComponent(path.slice(start + prefix.length).split("/")[0] ?? "")
}

/** The project store of a team, or the `500` that says how to set `VITEHUB_CONSOLE_SECRET`. */
function useConsoleProjects(teamId: string): ConsoleProjectStore | Response {
  const secret = process.env[consoleSecretVariable]
  const problem = consoleSecretProblem(secret)
  if (problem || !secret) return consoleProblem(500, "CONSOLE_SECRET_NOT_CONFIGURED", problem ?? "")
  return createConsoleProjectStore(() => useDatabase("default").db, secret, teamId)
}

export function allowPrivateProjects(): boolean {
  return process.env[allowPrivateVariable] === "true"
}

export const projectNotFound = (): Response => consoleProblem(404, "CONSOLE_PROJECT_NOT_FOUND", "There is no such project, or VITEHUB_CONSOLE_SECRET changed since it was linked.")

/**
 * Link a project to the team with a new key pair. The answer has its public key: set it in the project's
 * `VITEHUB_CONSOLE_KEY_<NAME>`, named by `keyVariable`. The private key stays on the Console server.
 */
export async function linkProject(caller: ConsoleTeamCaller, body: unknown): Promise<Response> {
  if (!canManageProjects(caller)) return consoleProblem(403, "CONSOLE_PROJECT_FORBIDDEN", "Only owners and admins of the team link projects.")
  const url: unknown = body instanceof Object ? Reflect.get(body, "url") : undefined
  const label: unknown = body instanceof Object ? Reflect.get(body, "label") : undefined
  if (String(url) !== url || (label !== undefined && String(label) !== label)) {
    return consoleProblem(400, "CONSOLE_PROJECT_INVALID", "Send { \"url\": \"https://app.example.com\" }, with an optional \"label\".")
  }
  const parsed = parseProjectUrl(url, { allowPrivate: allowPrivateProjects() })
  if ("error" in parsed) return consoleProblem(400, "CONSOLE_PROJECT_URL", parsed.error)
  const project = await caller.projects.create({ url: parsed.url, label, createdBy: caller.user.id })
  if (!project) return consoleProblem(409, "CONSOLE_PROJECT_EXISTS", `This team already linked ${parsed.url}.`)
  return consoleJson({ project }, 201)
}

/** Unlink a project. The Console deletes the private key of the link, so no call can be signed for it again. */
export async function unlinkProject(caller: ConsoleTeamCaller, id: string): Promise<Response> {
  if (!canManageProjects(caller)) return consoleProblem(403, "CONSOLE_PROJECT_FORBIDDEN", "Only owners and admins of the team unlink projects.")
  if (!await caller.projects.remove(id)) return consoleProblem(404, "CONSOLE_PROJECT_NOT_FOUND", "There is no such project.")
  return new Response(null, { status: 204 })
}

/** The answer of one operation call to a project: the value, or the failure and the HTTP status. */
export type ProjectOperationResult =
  | { ok: true, status: number, value: unknown }
  | { ok: false, status: number, error: { code?: string, message: string, fix?: string } }

function failureOf(value: unknown, status: number): { code?: string, message: string, fix?: string } {
  const field = (name: string) => {
    const found: unknown = value instanceof Object ? Reflect.get(value, name) : undefined
    return typeof found === "string" && found ? found : undefined
  }
  const code = field("code")
  const fix = field("fix")
  return { ...(code ? { code } : {}), message: field("message") ?? `The app answered ${status}.`, ...(fix ? { fix } : {}) }
}

/**
 * Call one operation of a team's project through the forward, signed with the key of the link for the person, or
 * `undefined` when the team has no such project.
 */
export async function callProjectOperation(caller: ConsoleTeamCaller, id: string, operation: string, input: unknown, options: ConsoleCallOptions = {}): Promise<ProjectOperationResult | undefined> {
  const target = await caller.projects.target(id)
  if (!target) return undefined
  const outcome = await callOperationRpc(operation, input, async (body) => {
    const call = new Request("https://console.invalid/", { body, headers: { "content-type": "application/json", "x-vitehub-console": "1" }, method: "POST" })
    // The forwarder signs the exact body that birpc wrote, so the signature covers this call.
    const response = await forwardProjectRequest(call, { caller: consoleCallerOf(caller, options), key: target.key, url: target.project.url }, operationRpcPath)
    return { body: await response.json().catch(() => undefined), response }
  })
  const { body, response } = outcome.answer
  if (outcome.ok) return { ok: true, status: response.status, value: outcome.value }
  // Host middleware, such as the signature check, answers with the diagnostic body and no birpc reply.
  return { error: failureOf(outcome.error ?? body, response.status), ok: false, status: response.status }
}

/**
 * Call `project.get` on the project with a signed request. A linked project answers `200`. Before the project has the
 * public key of the link, it answers `401` with `CONSOLE_KEY_UNKNOWN`, or `500` with `CONSOLE_KEY_NOT_CONFIGURED`.
 * `answer` is the value, or the diagnostic of the failure.
 */
export async function checkProject(caller: ConsoleTeamCaller, id: string, options: ConsoleCallOptions = {}): Promise<Response> {
  const result = await callProjectOperation(caller, id, "project.get", {}, options)
  if (!result) return projectNotFound()
  return consoleJson({ answer: result.ok ? result.value : result.error, linked: result.ok, status: result.status })
}
