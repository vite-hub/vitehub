import { consoleTeamRoute } from "../../../../utils/console.ts"
import { consoleEnvRoute } from "../../../../utils/env-values.ts"

export default consoleTeamRoute(async (request, caller) => consoleEnvRoute(request, caller))
