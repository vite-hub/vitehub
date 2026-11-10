import { forwardProjectRequest } from "../../../../../src/forward.ts"
import { consoleAdminRoute, consoleProblem, projectIdOf, useConsoleProjects } from "../../../../utils/console.ts"

// The Console page calls `/p/<project>/_vitehub/...`. The Console server sends the call to the project with its token.
export default consoleAdminRoute(async (request) => {
  const projects = useConsoleProjects()
  if (projects instanceof Response) return projects
  const id = projectIdOf(request, "/p/")
  const target = await projects.target(id)
  if (!target) return consoleProblem(404, "CONSOLE_PROJECT_NOT_FOUND", "There is no such project, or VITEHUB_CONSOLE_SECRET changed since it was linked.")
  const url = new URL(request.url)
  const app = url.pathname.slice(url.pathname.indexOf("/_vitehub/"))
  return forwardProjectRequest(request, { url: target.project.url, token: target.token }, `${app}${url.search}`)
})
