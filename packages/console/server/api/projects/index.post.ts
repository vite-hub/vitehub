import { consoleTeamRoute, linkProject } from "../../utils/console.ts"

export default consoleTeamRoute(async (request, caller) => linkProject(caller, await request.json().catch(() => undefined)))
