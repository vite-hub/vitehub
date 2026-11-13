import { and, eq } from "drizzle-orm"
import { authSqliteSchema } from "vite-hub/auth/schema"
import { withAuthorization } from "vite-hub/auth/server"
import { useDatabase } from "vite-hub/database"

import { createConsoleProjectStore } from "../../src/projects.ts"
import { allowPrivateVariable } from "../../src/project-url.ts"
import { consoleSecretProblem, consoleSecretVariable } from "../../src/token-box.ts"

import type { AuthAuthorization } from "@vite-hub/auth"
import type { ConsoleProjectStore } from "../../src/projects.ts"

export { consoleCallerOf } from "../../src/caller.ts"

const { member } = authSqliteSchema

export function consoleProblem(status: number, code: string, message: string): Response {
  return Response.json({ code, message, ok: false, status }, { headers: { "cache-control": "no-store" }, status })
}

export function consoleJson(value: unknown, status = 200): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" }, status })
}

/** The caller of a team route: the person, their active team, their role in it, and the projects of that team. */
export interface ConsoleTeamCaller {
  authorization: AuthAuthorization
  teamId: string
  /** Better Auth roles, such as `owner`, `admin`, or `member`. A member can have several, with commas between them. */
  roles: string[]
  projects: ConsoleProjectStore
}

/** Owners and admins link and unlink projects. Every member opens them. */
export function canManageProjects(caller: ConsoleTeamCaller): boolean {
  return caller.roles.includes("owner") || caller.roles.includes("admin")
}

/**
 * A route that runs its handler for a signed-in member of the session's active team. Others get `401`, or `403` when
 * the session has no team or the person left it.
 */
export function consoleTeamRoute(handler: (request: Request, caller: ConsoleTeamCaller) => Promise<Response>): { fetch(request: Request): Promise<Response> } {
  return {
    fetch: withAuthorization(true, async (request, authorization) => {
      const active: unknown = Reflect.get(authorization.session, "activeOrganizationId")
      const teamId = typeof active === "string" ? active : ""
      const { db } = useDatabase("default")
      const [membership] = teamId
        ? await db.select({ role: member.role }).from(member).where(and(eq(member.organizationId, teamId), eq(member.userId, authorization.user.id))).limit(1)
        : []
      if (!membership) return consoleProblem(403, "CONSOLE_TEAM_REQUIRED", "Choose a team that you are a member of.")
      const projects = useConsoleProjects(teamId)
      if (projects instanceof Response) return projects
      return handler(request, { authorization, projects, roles: String(membership.role).split(",").map(role => role.trim()), teamId })
    }),
  }
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
