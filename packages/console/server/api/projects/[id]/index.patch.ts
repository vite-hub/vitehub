import { consoleTeamRoute, projectIdOf, renameProject } from "../../../utils/console.ts"

// Rename a project: `{ "label": "Docs" }`. `{ "label": null }` removes the label, so the Console shows the name that the
// app reports. The key of the link does not change.
export default consoleTeamRoute(async (request, caller) => renameProject(caller, projectIdOf(request, "/api/projects/"), await request.json().catch(() => undefined)))
