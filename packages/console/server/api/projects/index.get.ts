import { consoleJson, consoleTeamRoute } from "../../utils/console.ts"

export default consoleTeamRoute(async (_request, { projects }) => consoleJson({ cliForwarding: true, projects: await projects.list() }))
