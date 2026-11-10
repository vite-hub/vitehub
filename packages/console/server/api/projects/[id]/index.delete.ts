import { consoleAdminRoute, consoleProblem, projectIdOf, useConsoleProjects } from "../../../utils/console.ts"

// Unlink a project. Its token stops working only when the project removes the hash from `VITEHUB_CONSOLE_TOKEN_SHA256`.
export default consoleAdminRoute(async (request) => {
  const projects = useConsoleProjects()
  if (projects instanceof Response) return projects
  if (!await projects.remove(projectIdOf(request, "/api/projects/"))) return consoleProblem(404, "CONSOLE_PROJECT_NOT_FOUND", "There is no such project.")
  return new Response(null, { status: 204 })
})
