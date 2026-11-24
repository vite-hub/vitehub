import { and, desc, eq, isNotNull } from "drizzle-orm"
import { authSqliteSchema } from "vite-hub/auth/schema"
import { withAuthorization } from "vite-hub/auth/server"
import { useDatabase } from "vite-hub/database"

import { callOperationRpc, operationRpcPath } from "@vite-hub/internal/operation-rpc"

import { consoleErrorDiagnostics } from "../../src/error-diagnostics.ts"
import { forwardProjectRequest } from "../../src/forward.ts"
import { consumeForwardBudget, forwardBudget } from "../../src/forward-budget.ts"
import { consoleCallerOf, consoleCallerUser, type ConsoleCallOptions } from "../../src/caller.ts"
import { consoleApiKeyOf, createConsoleApiKey, defaultApiKeyDays, maxApiKeyDays, verifyConsoleApiKey } from "../../src/api-keys.ts"
import { createConsoleProjectStore, listConsoleProjects, scopeConsoleProjectStore } from "../../src/projects.ts"
import { allowPrivateVariable, parseProjectUrl } from "../../src/project-url.ts"
import { consoleSecretProblem, consoleSecretVariable } from "../../src/token-box.ts"

import type { ConsoleCallerUser } from "@vite-hub/internal/console-signature"
import type { Diagnostic } from "nostics"
import type { ConsoleProjectStore } from "../../src/projects.ts"

export { consoleCallerOf, consoleCallerUser, type ConsoleCallOptions } from "../../src/caller.ts"

const { member, organization, session, user: authUser } = authSqliteSchema

export function consoleProblem(status: number, code: string, message: string): Response {
  return Response.json({ code, message, ok: false, status }, { headers: { "cache-control": "no-store" }, status })
}

export function consoleDiagnosticProblem(status: number, diagnostic: Diagnostic<unknown>, headers: Record<string, string> = {}): Response {
  const { code, docs, fix, why } = diagnostic
  return Response.json({ code, docs, fix, message: why, ok: false, status }, { headers: { "cache-control": "no-store", ...headers }, status })
}

export async function spendForwardBudget(caller: ConsoleTeamCaller, id: string): Promise<{ diagnostic: Diagnostic<unknown>, retryAfter: number } | undefined> {
  const retryAfter = await consumeForwardBudget(useDatabase("default").db, caller.user.id, id)
  if (retryAfter === undefined) return undefined
  return { diagnostic: consoleErrorDiagnostics.CONSOLE_FORWARD_RATE_LIMITED({ limit: forwardBudget.limit, retryAfter }), retryAfter }
}

export function consoleJson(value: unknown, status = 200): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" }, status })
}

export interface ConsoleTeamCaller {
  user: ConsoleCallerUser
  teamId: string
  roles: string[]
  projects: ConsoleProjectStore
  projectIds?: string[] | null
}

export function canManageProjects(caller: ConsoleTeamCaller): boolean {
  return !caller.projectIds && (caller.roles.includes("owner") || caller.roles.includes("admin"))
}

export async function consoleTeamCaller(user: ConsoleCallerUser, teamId: string): Promise<ConsoleTeamCaller | Response> {
  const userId = user.id
  const { db } = useDatabase("default")
  const [membership] = teamId
    ? await db.select({ role: member.role, email: authUser.email, emailVerified: authUser.emailVerified }).from(member)
      .innerJoin(authUser, eq(authUser.id, member.userId)).where(and(eq(member.organizationId, teamId), eq(member.userId, userId))).limit(1)
    : []
  if (!membership) return consoleProblem(403, "CONSOLE_TEAM_REQUIRED", "Choose a team that you are a member of.")
  const projects = useConsoleProjects(teamId)
  if (projects instanceof Response) return projects
  return { projects, roles: String(membership.role).split(",").map(role => role.trim()), teamId, user: consoleCallerUser({ ...user, email: membership.email, emailVerified: membership.emailVerified }) }
}

export interface ConsoleKeyCaller extends ConsoleTeamCaller {
  key: { id: string, expiresAt: number }
  team: { id: string, name: string }
}

export async function consoleKeyCaller(request: Request): Promise<ConsoleKeyCaller | Response | undefined> {
  const key = consoleApiKeyOf(request)
  if (!key) return undefined
  const found = await verifyConsoleApiKey(useDatabase("default").db, key)
  if (!found) return consoleProblem(401, "CONSOLE_API_KEY_INVALID", "The API key is unknown, revoked, or expired. Run `vitehub login` again.")
  const projects = useConsoleProjects(found.teamId)
  if (projects instanceof Response) return projects
  return {
    key: { expiresAt: found.expiresAt, id: found.keyId },
    projectIds: found.projectIds,
    projects: scopeConsoleProjectStore(projects, found.projectIds),
    roles: found.roles,
    team: { id: found.teamId, name: found.teamName },
    teamId: found.teamId,
    user: consoleCallerUser(found.user),
  }
}

export async function createApiKeyFor(userId: string, sessionTeam: unknown, body: unknown): Promise<Response> {
  const field = (name: string): unknown => body instanceof Object ? Reflect.get(body, name) : undefined
  const name = field("name")
  const teamId = field("teamId") ?? sessionTeam
  const projectIds = field("projectIds") ?? null
  const days = field("days") ?? defaultApiKeyDays
  const valid = typeof name === "string" && name.trim().length > 0 && name.length <= 100
    && typeof teamId === "string" && teamId.length > 0
    && (projectIds === null || (Array.isArray(projectIds) && projectIds.every(id => typeof id === "string")))
    && typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= maxApiKeyDays
  if (!valid) return consoleProblem(400, "CONSOLE_API_KEY_INVALID_INPUT", `Send { "name": "CI" }, with an optional "teamId", "projectIds" of that team, and "days" from 1 to ${maxApiKeyDays}.`)
  const { db } = useDatabase("default")
  const ids: string[] | null = Array.isArray(projectIds) && projectIds.length ? projectIds.map(String) : null
  if (ids) {
    const known = new Set((await listConsoleProjects(db, teamId)).map(project => project.id))
    const unknown = ids.filter(id => !known.has(id))
    if (unknown.length) return consoleProblem(400, "CONSOLE_API_KEY_PROJECT_UNKNOWN", `The team has no project ${unknown.join(", ")}.`)
  }
  const created = await createConsoleApiKey(db, { days, name, projectIds: ids, teamId, userId })
  if (!created) return consoleProblem(403, "CONSOLE_TEAM_REQUIRED", "Choose a team that you are a member of.")
  return consoleJson({ apiKey: created.apiKey, key: created.key }, 201)
}

export function consoleTeamRoute(handler: (request: Request, caller: ConsoleTeamCaller) => Promise<Response>): { fetch(request: Request): Promise<Response> } {
  const withSession = withAuthorization(true, async (request: Request, authorization) => {
    const active: unknown = Reflect.get(authorization.session, "activeOrganizationId")
    const caller = await consoleTeamCaller(consoleCallerUser(authorization.user), typeof active === "string" ? active : "")
    return caller instanceof Response ? caller : handler(request, caller)
  })
  return {
    async fetch(request) {
      const caller = await consoleKeyCaller(request)
      if (caller === undefined) return withSession(request)
      return caller instanceof Response ? caller : handler(request, caller)
    },
  }
}

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

export function projectIdOf(request: Request, prefix: "/api/projects/" | "/p/"): string {
  const path = new URL(request.url).pathname
  const start = path.indexOf(prefix)
  return start === -1 ? "" : decodeURIComponent(path.slice(start + prefix.length).split("/")[0] ?? "")
}

export function useConsoleProjects(teamId: string): ConsoleProjectStore | Response {
  const secret = process.env[consoleSecretVariable]
  const problem = consoleSecretProblem(secret)
  if (problem || !secret) return consoleProblem(500, "CONSOLE_SECRET_NOT_CONFIGURED", problem ?? "")
  return createConsoleProjectStore(() => useDatabase("default").db, secret, teamId)
}

export function allowPrivateProjects(): boolean {
  return process.env[allowPrivateVariable] === "true"
}

export const projectNotFound = (): Response => consoleProblem(404, "CONSOLE_PROJECT_NOT_FOUND", "There is no such project, or VITEHUB_CONSOLE_SECRET changed since it was linked.")

export async function linkProject(caller: ConsoleTeamCaller, body: unknown): Promise<Response> {
  if (!canManageProjects(caller)) return consoleProblem(403, "CONSOLE_PROJECT_FORBIDDEN", caller.projectIds ? "An API key for some projects cannot link projects." : "Only owners and admins of the team link projects.")
  const url: unknown = body instanceof Object ? Reflect.get(body, "url") : undefined
  const label: unknown = body instanceof Object ? Reflect.get(body, "label") : undefined
  const kind: unknown = body instanceof Object ? Reflect.get(body, "kind") : undefined
  if (String(url) !== url || (label !== undefined && String(label) !== label) || (kind !== undefined && kind !== "site")) {
    return consoleProblem(400, "CONSOLE_PROJECT_INVALID", "Send { \"url\": \"https://app.example.com\" }, with an optional \"label\". Use \"kind\": \"site\" to register a site for Hosted Comments.")
  }
  const parsed = parseProjectUrl(url, { allowPrivate: allowPrivateProjects() })
  if ("error" in parsed) return consoleProblem(400, "CONSOLE_PROJECT_URL", parsed.error)
  const input = { url: parsed.url, label, createdBy: caller.user.id }
  const project = kind === "site" ? await caller.projects.registerSite(input) : await caller.projects.create(input)
  if (!project) return consoleProblem(409, "CONSOLE_PROJECT_EXISTS", `This team already linked ${parsed.url}.`)
  return consoleJson({ project }, 201)
}

export async function renameProject(caller: ConsoleTeamCaller, id: string, body: unknown): Promise<Response> {
  if (!canManageProjects(caller)) return consoleProblem(403, "CONSOLE_PROJECT_FORBIDDEN", "Only owners and admins of the team rename projects.")
  const label: unknown = body instanceof Object && "label" in body ? Reflect.get(body, "label") : undefined
  if (label !== null && String(label) !== label) return consoleProblem(400, "CONSOLE_PROJECT_INVALID", "Send { \"label\": \"Docs\" }, or { \"label\": null } to remove the label.")
  const project = await caller.projects.rename(id, label)
  return project ? consoleJson({ project }) : consoleProblem(404, "CONSOLE_PROJECT_NOT_FOUND", "There is no such project.")
}

export async function unlinkProject(caller: ConsoleTeamCaller, id: string, deleteHostedComments: boolean): Promise<Response> {
  if (!canManageProjects(caller)) return consoleProblem(403, "CONSOLE_PROJECT_FORBIDDEN", "Only owners and admins of the team unlink projects.")
  if (!deleteHostedComments) return consoleDiagnosticProblem(409, consoleErrorDiagnostics.CONSOLE_HOSTED_COMMENTS_DELETE_UNCONFIRMED())
  if (!await caller.projects.remove(id)) return consoleProblem(404, "CONSOLE_PROJECT_NOT_FOUND", "There is no such project.")
  return new Response(null, { status: 204 })
}

export type ProjectOperationResult =
  | { ok: true, status: number, value: unknown }
  | { ok: false, status: number, error: ProjectOperationFailure }

export interface ProjectOperationFailure {
  code?: string
  message: string
  fix?: string
}

function failureOf(value: unknown, status: number): ProjectOperationFailure {
  const field = (name: string) => {
    const found: unknown = value instanceof Object ? Reflect.get(value, name) : undefined
    return typeof found === "string" && found ? found : undefined
  }
  const code = field("code")
  const fix = field("fix")
  return { ...(code ? { code } : {}), message: field("message") ?? `The app answered ${status}.`, ...(fix ? { fix } : {}) }
}

export async function callProjectOperation(caller: ConsoleTeamCaller, id: string, operation: string, input: unknown, options: ConsoleCallOptions = {}): Promise<ProjectOperationResult | undefined> {
  const result = await signedProjectCall(caller, id, operation, input, options)
  if (!result || !refusedCallerFields(result, options)) return result
  const outdated = outdatedApp(await signedProjectCall(caller, id, "project.get", {}))
  return outdated ? { error: outdated, ok: false, status: result.status } : result
}

async function signedProjectCall(caller: ConsoleTeamCaller, id: string, operation: string, input: unknown, options: ConsoleCallOptions = {}): Promise<ProjectOperationResult | undefined> {
  const target = await caller.projects.target(id)
  if (!target) return undefined
  const spent = await spendForwardBudget(caller, id)
  if (spent) {
    const { code, fix, why } = spent.diagnostic
    return { error: { code, fix, message: why }, ok: false, status: 429 }
  }
  const outcome = await callOperationRpc(operation, input, async (body) => {
    const call = new Request("https://console.invalid/", { body, headers: { "content-type": "application/json", "x-vitehub-console": "1" }, method: "POST" })
    const response = await forwardProjectRequest(call, { caller: consoleCallerOf(caller, options), key: target.key, url: target.project.url }, operationRpcPath)
    return { body: await response.json().catch(() => undefined), response }
  })
  const { body, response } = outcome.answer
  if (outcome.ok) return { ok: true, status: response.status, value: outcome.value }
  return { error: failureOf(outcome.error ?? body, response.status), ok: false, status: response.status }
}

function refusedCallerFields(result: ProjectOperationResult, options: ConsoleCallOptions): boolean {
  return !result.ok && result.status === 401 && result.error.code === "CONSOLE_SIGNATURE_INVALID" && Boolean(options.surface || options.readOnly)
}

function outdatedApp(project: ProjectOperationResult | undefined): ProjectOperationFailure | undefined {
  const version: unknown = project?.ok && project.value instanceof Object ? Reflect.get(project.value, "vitehub") : undefined
  if (typeof version !== "string") return undefined
  const { code, fix, why } = consoleErrorDiagnostics.CONSOLE_APP_VITEHUB_OUTDATED({ version })
  return { code, fix, message: why }
}

export async function checkProject(caller: ConsoleTeamCaller, id: string, options: ConsoleCallOptions = {}): Promise<Response> {
  const first = await signedProjectCall(caller, id, "project.get", {}, options)
  const result = first && refusedCallerFields(first, options) ? await signedProjectCall(caller, id, "project.get", {}) : first
  if (!result) return projectNotFound()
  return consoleJson({ answer: result.ok ? result.value : result.error, linked: result.ok, status: result.status })
}
