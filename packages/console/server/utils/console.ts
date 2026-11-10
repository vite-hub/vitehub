import { withAuthorization } from "vite-hub/auth/server"
import { useDatabase } from "vite-hub/database"

import { createConsoleProjectStore } from "../../src/projects.ts"
import { allowPrivateVariable } from "../../src/project-url.ts"
import { consoleSecretProblem, consoleSecretVariable } from "../../src/token-box.ts"

import type { AuthAuthorization } from "@vite-hub/auth"
import type { ConsoleProjectStore } from "../../src/projects.ts"

export function consoleProblem(status: number, code: string, message: string): Response {
  return Response.json({ code, message, ok: false, status }, { headers: { "cache-control": "no-store" }, status })
}

export function consoleJson(value: unknown, status = 200): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" }, status })
}

/** Whether a user has the `admin` role. Better Auth's `admin()` plugin keeps several roles with commas between them. */
function isAdmin(user: AuthAuthorization["user"]): boolean {
  return String(user.role ?? "").split(",").map(role => role.trim()).includes("admin")
}

/** A route that runs its handler only for a signed-in Console admin. Others get `401` or `403`. */
export function consoleAdminRoute(handler: (request: Request, authorization: AuthAuthorization) => Promise<Response>): { fetch(request: Request): Promise<Response> } {
  return { fetch: withAuthorization(({ user }) => isAdmin(user), handler) }
}

/** The project id in a route path, such as `<id>` in `/api/projects/<id>/check` or `/p/<id>/_vitehub/...`. */
export function projectIdOf(request: Request, prefix: "/api/projects/" | "/p/"): string {
  const path = new URL(request.url).pathname
  const start = path.indexOf(prefix)
  return start === -1 ? "" : decodeURIComponent(path.slice(start + prefix.length).split("/")[0] ?? "")
}

/** The project store, or the `500` that says how to set `VITEHUB_CONSOLE_SECRET`. */
export function useConsoleProjects(): ConsoleProjectStore | Response {
  const secret = process.env[consoleSecretVariable]
  const problem = consoleSecretProblem(secret)
  if (problem || !secret) return consoleProblem(500, "CONSOLE_SECRET_NOT_CONFIGURED", problem ?? "")
  return createConsoleProjectStore(() => useDatabase("default").db, secret)
}

export function allowPrivateProjects(): boolean {
  return process.env[allowPrivateVariable] === "true"
}
