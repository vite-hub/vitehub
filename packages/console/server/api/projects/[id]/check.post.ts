import { forwardProjectRequest } from "../../../../src/forward.ts"
import { consoleAdminRoute, consoleJson, consoleProblem, projectIdOf, useConsoleProjects } from "../../../utils/console.ts"

// Call `project.get` on the project with its token. A linked project answers `200`. Before the project has the hash
// of the token, it answers `401` with `CONSOLE_TOKEN_INVALID`.
export default consoleAdminRoute(async (request) => {
  const projects = useConsoleProjects()
  if (projects instanceof Response) return projects
  const target = await projects.target(projectIdOf(request, "/api/projects/"))
  if (!target) return consoleProblem(404, "CONSOLE_PROJECT_NOT_FOUND", "There is no such project, or VITEHUB_CONSOLE_SECRET changed since it was linked.")
  const call = new Request("https://console.invalid/", {
    body: JSON.stringify({ input: {}, operation: "project.get" }),
    headers: { "content-type": "application/json", "x-vitehub-console": "1" },
    method: "POST",
  })
  const response = await forwardProjectRequest(call, { url: target.project.url, token: target.token }, "/_vitehub/rpc/__call")
  const answer: unknown = await response.json().catch(() => undefined)
  return consoleJson({ answer, linked: response.ok, status: response.status })
})
