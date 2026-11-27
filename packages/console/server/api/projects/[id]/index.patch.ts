import { consoleTeamRoute, projectIdOf, renameProject } from "../../../utils/console.ts"

export default consoleTeamRoute(async (request, caller) => renameProject(caller, projectIdOf(request, "/api/projects/"), await request.json().catch(() => undefined)))
