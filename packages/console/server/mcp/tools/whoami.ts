import { defineMcpTool } from "vite-hub/mcp"

import { mcpTeamCaller } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "Who am I",
  description: "Show the person that the tools act as, and the team and roles that they act on: the team that the person opened last in the Console. Only owners and admins may link and unlink apps. The team can differ from the CLI key's team shown by `vitehub whoami`.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (_input, { caller }) => {
    const { projectIds, roles, team, user } = await mcpTeamCaller(caller)
    return { projectIds: projectIds ?? null, roles, team: { id: team.id, name: team.name }, user }
  },
})
