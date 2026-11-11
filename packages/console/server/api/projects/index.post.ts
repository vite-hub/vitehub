import { consoleTeamRoute, linkProject } from "../../utils/console.ts"

// Link a project to the active team: `{ "url": "https://app.example.com", "label": "Docs" }`.
export default consoleTeamRoute(async (request, caller) => linkProject(caller, await request.json().catch(() => undefined)))
