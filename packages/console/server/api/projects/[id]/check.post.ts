import { checkProject, consoleTeamRoute, projectIdOf } from "../../../utils/console.ts"

// Call `project.get` on the project with its token. `linked` is `true` once the project has the hash of the token.
export default consoleTeamRoute(async (request, caller) => checkProject(caller, projectIdOf(request, "/api/projects/")))
