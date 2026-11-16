import { consoleTeamRoute } from "../../../../utils/console.ts"
import { consoleEnvRoute } from "../../../../utils/env-values.ts"

// The env stages of a project. See `consoleEnvRoute()` for the routes under /env.
export default consoleTeamRoute(async (request, caller) => consoleEnvRoute(request, caller))
