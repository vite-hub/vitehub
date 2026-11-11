import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { linkProject } from "../../utils/console.ts"
import { consoleToolAnswer, mcpTeamCaller } from "../../utils/mcp.ts"

import type { ConsoleProject } from "../../../src/projects.ts"

export default defineMcpTool({
  title: "Link an app",
  description: "Link a deployed ViteHub app to your team. Only owners and admins of the team may link. The answer has the variable line with the public key of the link: add it to the app's environment, set console: { auth: \"token\" } in its vitehub config, deploy, then call check_app.",
  input: z.object({
    url: z.string().describe("The https:// URL of the app, with its base path if it has one, such as https://app.example.com"),
    label: z.string().optional().describe("A name for the app in the Console"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  handler: async (input, { caller }) => {
    const member = await mcpTeamCaller(caller)
    // SAFETY: A `201` of `linkProject()` has the new project.
    const { project } = await consoleToolAnswer(await linkProject(member, input)) as { project: ConsoleProject }
    return {
      app: project,
      variable: `${project.keyVariable}=${project.publicKey}`,
      next: `Set ${project.keyVariable} in the environment of ${project.url}, with console: { auth: "token" } in its vitehub config. Deploy it, then call check_app with id ${project.id}.`,
    }
  },
})
