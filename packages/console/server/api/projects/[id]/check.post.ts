import { checkProject, consoleTeamRoute, projectIdOf } from "../../../utils/console.ts"

// Call `project.get` on the project with a signed request. `linked` is `true` once the project has the public key of
// the link. Before that, it answers `401` with `CONSOLE_KEY_UNKNOWN`, or `500` with `CONSOLE_KEY_NOT_CONFIGURED`.
export default consoleTeamRoute(async (request, caller) => checkProject(caller, projectIdOf(request, "/api/projects/")))
