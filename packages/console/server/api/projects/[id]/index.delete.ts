import { consoleTeamRoute, projectIdOf, unlinkProject } from "../../../utils/console.ts"

// Unlink a project. The Console deletes the private key of the link. The project can remove its
// `VITEHUB_CONSOLE_KEY_CONSOLE_<id>` variable too.
export default consoleTeamRoute(async (request, caller) => unlinkProject(caller, projectIdOf(request, "/api/projects/")))
