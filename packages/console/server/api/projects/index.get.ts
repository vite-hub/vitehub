import { consoleJson, consoleTeamRoute } from "../../utils/console.ts"

// The projects of the active team.
export default consoleTeamRoute(async (_request, { projects }) => consoleJson({ projects: await projects.list() }))
