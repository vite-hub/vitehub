import { consoleTeamRoute, projectIdOf, unlinkProject } from "../../../utils/console.ts"

export default consoleTeamRoute(async (request, caller) => unlinkProject(caller, projectIdOf(request, "/api/projects/")))
