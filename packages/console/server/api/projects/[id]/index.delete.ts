import { canManageProjects, consoleProblem, consoleTeamRoute, projectIdOf } from "../../../utils/console.ts"

// Unlink a project. The Console deletes the private key of the link. The project can remove its
// `VITEHUB_CONSOLE_KEY_CONSOLE_<id>` variable too.
export default consoleTeamRoute(async (request, caller) => {
  if (!canManageProjects(caller)) return consoleProblem(403, "CONSOLE_PROJECT_FORBIDDEN", "Only owners and admins of the team unlink projects.")
  const { projects } = caller
  if (!await projects.remove(projectIdOf(request, "/api/projects/"))) return consoleProblem(404, "CONSOLE_PROJECT_NOT_FOUND", "There is no such project.")
  return new Response(null, { status: 204 })
})
