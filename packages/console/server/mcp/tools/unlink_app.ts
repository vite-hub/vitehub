import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { projectNotFound, unlinkProject } from "../../utils/console.ts"
import { consoleToolAnswer, consoleToolError, mcpTeamCaller } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "Unlink an app",
  description: "Unlink an app from your team. Only owners and admins may unlink. This deletes the link's private key and permanently deletes its hosted comment threads and replies. Then remove the link's variable from the app.",
  input: z.object({
    id: z.string().describe("The app id from list_apps"),
    deleteHostedComments: z.boolean().optional().describe("Set true after the user confirms permanent deletion of hosted threads and replies."),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ id, deleteHostedComments }, { caller }) => {
    const member = await mcpTeamCaller(caller)
    const project = await member.projects.get(id)
    if (!project) throw await consoleToolError(projectNotFound())
    await consoleToolAnswer(await unlinkProject(member, id, deleteHostedComments === true))
    return { unlinked: id, next: `Remove ${project.keyVariable} from the environment of ${project.url}.` }
  },
})
