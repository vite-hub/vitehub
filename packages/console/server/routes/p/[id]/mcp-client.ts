import { consoleOutboundFetch } from "#console-outbound-fetch"
import { resolvePublicUrl } from "@vite-hub/runtime"
import { useDatabase } from "vite-hub/database"

import { databaseConsoleMcpRecords } from "../../../../src/mcp-client-records.ts"
import { answerConsoleMcpCall, consoleMcpCompletionProject, consoleMcpReplyStatus, readConsoleMcpRequest } from "../../../../src/mcp-client-rpc.ts"
import { consoleMcpCallbackPath } from "../../../../src/mcp-client-types.ts"
import { memberConsoleProject } from "../../../../src/projects.ts"
import { consoleSecretProblem, consoleSecretVariable } from "../../../../src/token-box.ts"
import { allowPrivateProjects, consoleDiagnosticProblem, consoleProblem, consoleTeamRoute, projectIdOf, projectNotFound, spendForwardBudget } from "../../../utils/console.ts"

export default consoleTeamRoute(async (request, caller) => {
  if (request.method !== "POST") return new Response(null, { headers: { allow: "POST" }, status: 405 })
  if (request.headers.get("x-vitehub-console") !== "1" || !request.headers.get("content-type")?.startsWith("application/json")) {
    return consoleProblem(403, "CONSOLE_ACCESS_DENIED", "Send MCP client calls from the Console page, as JSON with the x-vitehub-console header.")
  }
  if ("key" in caller) return consoleProblem(403, "CONSOLE_ACCESS_DENIED", "MCP connections of the Console belong to the person who signed in to the Console page. API keys cannot use them.")
  const secret = process.env[consoleSecretVariable]
  const problem = consoleSecretProblem(secret)
  if (problem || !secret) return consoleProblem(500, "CONSOLE_SECRET_NOT_CONFIGURED", problem ?? "")
  const text = await readConsoleMcpRequest(request)
  if (text === undefined) return consoleProblem(413, "CONSOLE_REQUEST_INVALID", "The call is too large. Send tool arguments under 256 KiB.")
  let body: unknown
  try {
    body = JSON.parse(text)
  }
  catch {
    return consoleProblem(400, "CONSOLE_REQUEST_INVALID", "The request body is not JSON.")
  }
  const { db } = useDatabase("default")
  const stateProject = consoleMcpCompletionProject(body)
  const project = stateProject !== undefined ? await memberConsoleProject(db, caller.user.id, stateProject) : await caller.projects.get(projectIdOf(request, "/p/"))
  if (!project) return projectNotFound()
  const spent = await spendForwardBudget(caller, project.id)
  if (spent) return consoleDiagnosticProblem(429, spent.diagnostic, { "retry-after": String(spent.retryAfter) })
  const allowPrivate = allowPrivateProjects()
  const reply = await answerConsoleMcpCall(body, {
    allowPrivate,
    appOrigin: new URL(project.url).origin,
    fetch: consoleOutboundFetch(allowPrivate),
    projectId: project.id,
    records: databaseConsoleMcpRecords(db, secret),
    redirectUrl: `${resolvePublicUrl({ request }) ?? new URL(request.url).origin}${consoleMcpCallbackPath}`,
    teamId: project.teamId,
    userId: caller.user.id,
  })
  return Response.json(reply, { headers: { "cache-control": "no-store" }, status: consoleMcpReplyStatus(reply) })
})
