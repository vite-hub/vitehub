import { forwardProjectRequest } from "../../../../../src/forward.ts"
import { consoleCallerOf, consoleProblem, consoleTeamRoute, projectIdOf } from "../../../../utils/console.ts"

// The Console page calls `/p/<project>/_vitehub/...`. The Console server signs the call for the person and sends it to
// the project.
export default consoleTeamRoute(async (request, caller) => {
  const { projects } = caller
  const id = projectIdOf(request, "/p/")
  const target = await projects.target(id)
  if (!target) return consoleProblem(404, "CONSOLE_PROJECT_NOT_FOUND", "There is no such project, or VITEHUB_CONSOLE_SECRET changed since it was linked.")
  const url = new URL(request.url)
  const app = url.pathname.slice(url.pathname.indexOf("/_vitehub/"))
  return forwardProjectRequest(request, { caller: consoleCallerOf(caller), key: target.key, url: target.project.url }, `${app}${url.search}`)
})
