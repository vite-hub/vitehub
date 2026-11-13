import { callOperationRpc, operationRpcPath } from "@vite-hub/internal/operation-rpc"

import { forwardProjectRequest } from "../../../../src/forward.ts"
import { consoleCallerOf, consoleJson, consoleProblem, consoleTeamRoute, projectIdOf } from "../../../utils/console.ts"

// Call `project.get` on the project with a signed request. A linked project answers `200`. Before the project has the
// public key of the link, it answers `401` with `CONSOLE_KEY_UNKNOWN`, or `500` with `CONSOLE_KEY_NOT_CONFIGURED` when
// it has no key at all. `answer` is the value, or the diagnostic of the failure.
export default consoleTeamRoute(async (request, caller) => {
  const { projects } = caller
  const target = await projects.target(projectIdOf(request, "/api/projects/"))
  if (!target) return consoleProblem(404, "CONSOLE_PROJECT_NOT_FOUND", "There is no such project, or VITEHUB_CONSOLE_SECRET changed since it was linked.")
  const outcome = await callOperationRpc("project.get", {}, async (body) => {
    const call = new Request("https://console.invalid/", { body, headers: { "content-type": "application/json", "x-vitehub-console": "1" }, method: "POST" })
    // The forwarder signs the exact body that birpc wrote, so the signature covers this call.
    const response = await forwardProjectRequest(call, { caller: consoleCallerOf(caller), key: target.key, url: target.project.url }, operationRpcPath)
    return { body: await response.json().catch(() => undefined), response }
  })
  const { response } = outcome.answer
  // Host middleware, such as the signature check, answers with the diagnostic body and no birpc reply.
  const answer = outcome.ok ? outcome.value : outcome.error ?? outcome.answer.body
  return consoleJson({ answer, linked: response.ok, status: response.status })
})
