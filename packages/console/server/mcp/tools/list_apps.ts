import { defineMcpTool } from "vite-hub/mcp"

import { mcpTeamCaller } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "List apps",
  description: "List the apps that your team linked to the ViteHub Console, with the id that the other app tools take. The tools act on the team that you opened last in the Console.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (_input, { caller }) => {
    const { projects, team } = await mcpTeamCaller(caller)
    return { apps: await projects.list(), team }
  },
})
