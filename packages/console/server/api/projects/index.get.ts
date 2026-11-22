import { consoleJson, consoleTeamRoute } from "../../utils/console.ts"

export default consoleTeamRoute(async (_request, { projects }) => consoleJson({ projects: await projects.list() }))
