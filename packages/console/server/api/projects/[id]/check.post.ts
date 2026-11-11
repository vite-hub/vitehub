import { callOperationRpc, operationRpcPath } from "@vite-hub/internal/operation-rpc"

import { forwardProjectRequest } from "../../../../src/forward.ts"
import { consoleJson, consoleProblem, consoleTeamRoute, projectIdOf } from "../../../utils/console.ts"

// Call `project.get` on the project with its token. A linked project answers `200`. Before the project has the hash
// of the token, it answers `401` with `CONSOLE_TOKEN_INVALID`. `answer` is the value, or the diagnostic of the failure.
export default consoleTeamRoute(async (request, { projects }) => {
  const target = await projects.target(projectIdOf(request, "/api/projects/"))
  if (!target) return consoleProblem(404, "CONSOLE_PROJECT_NOT_FOUND", "There is no such project, or VITEHUB_CONSOLE_SECRET changed since it was linked.")
  const outcome = await callOperationRpc("project.get", {}, async (body) => {
    const call = new Request("https://console.invalid/", { body, headers: { "content-type": "application/json", "x-vitehub-console": "1" }, method: "POST" })
    const response = await forwardProjectRequest(call, { url: target.project.url, token: target.token }, operationRpcPath)
    return { body: await response.json().catch(() => undefined), response }
  })
  const { response } = outcome.answer
  // Host middleware, such as the token check, answers with the diagnostic body and no birpc reply.
  const answer = outcome.ok ? outcome.value : outcome.error ?? outcome.answer.body
  return consoleJson({ answer, linked: response.ok, status: response.status })
})
