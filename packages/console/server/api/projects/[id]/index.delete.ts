import { canManageProjects, consoleProblem, consoleTeamRoute, projectIdOf } from "../../../utils/console.ts"

// Unlink a project. Its token stops working only when the project removes the hash from `VITEHUB_CONSOLE_TOKEN_SHA256`.
export default consoleTeamRoute(async (request, caller) => {
  if (!canManageProjects(caller)) return consoleProblem(403, "CONSOLE_PROJECT_FORBIDDEN", "Only owners and admins of the team unlink projects.")
  const { projects } = caller
  if (!await projects.remove(projectIdOf(request, "/api/projects/"))) return consoleProblem(404, "CONSOLE_PROJECT_NOT_FOUND", "There is no such project.")
  return new Response(null, { status: 204 })
})
