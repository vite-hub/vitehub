import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { projectNotFound, unlinkProject } from "../../utils/console.ts"
import { consoleToolAnswer, consoleToolError, mcpTeamCaller } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "Unlink an app",
  description: "Unlink an app from your team. Only owners and admins of the team may unlink. The Console deletes the private key of the link. Then remove the link's variable from the app.",
  input: z.object({ id: z.string().describe("The app id from list_apps") }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ id }, { caller }) => {
    const member = await mcpTeamCaller(caller)
    const project = await member.projects.get(id)
    if (!project) throw await consoleToolError(projectNotFound())
    await consoleToolAnswer(await unlinkProject(member, id))
    return { unlinked: id, next: `Remove ${project.keyVariable} from the environment of ${project.url}.` }
  },
})
