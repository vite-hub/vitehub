import { consoleTeamRoute, linkProject } from "../../utils/console.ts"

// Link a project to the active team: `{ "url": "https://app.example.com", "label": "Docs" }`. The answer has the public
// key of the new key pair: set it in the project's `VITEHUB_CONSOLE_KEY_<NAME>`, named by `keyVariable`.
export default consoleTeamRoute(async (request, caller) => linkProject(caller, await request.json().catch(() => undefined)))
