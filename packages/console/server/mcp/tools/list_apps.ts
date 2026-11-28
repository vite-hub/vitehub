import { defineMcpTool } from "vite-hub/mcp"

import { mcpTeamCaller } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "List apps",
  description: "List the apps that your team linked to the ViteHub Console, with the id that the other app tools take. The tools act on the team that you opened last in the Console. A site for Hosted Comments has keyVariable null: on it, list_operations, read_operation, and run_operation take comments.threads, comments.reply, comments.resolve, and comments.reopen, with the same input as on an app.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (_input, { caller }) => {
    const { projects, team } = await mcpTeamCaller(caller)
    return { apps: await projects.list(), team }
  },
})
