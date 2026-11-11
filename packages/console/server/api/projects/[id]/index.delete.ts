import { consoleTeamRoute, projectIdOf, unlinkProject } from "../../../utils/console.ts"

// Unlink a project. Its token stops working only when the project removes the hash from `VITEHUB_CONSOLE_TOKEN_SHA256`.
export default consoleTeamRoute(async (request, caller) => unlinkProject(caller, projectIdOf(request, "/api/projects/")))
