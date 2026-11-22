import { checkProject, consoleTeamRoute, projectIdOf } from "../../../utils/console.ts"

export default consoleTeamRoute(async (request, caller) => checkProject(caller, projectIdOf(request, "/api/projects/")))
