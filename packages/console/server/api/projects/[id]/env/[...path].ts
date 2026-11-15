import { consoleTeamRoute } from "../../../../utils/console.ts"
import { consoleEnvRoute } from "../../../../utils/env-values.ts"

// The env values of a project: list names, set, delete, reveal, and activity. Off unless the Console operator sets
// VITEHUB_CONSOLE_ENV_VALUES=1 and VITEHUB_CONSOLE_ENV_KEY. See `consoleEnvRoute()`.
export default consoleTeamRoute(async (request, caller) => consoleEnvRoute(request, caller))
