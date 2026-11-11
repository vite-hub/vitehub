import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { checkProject } from "../../utils/console.ts"
import { consoleToolAnswer, mcpTeamCaller } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "Check an app",
  description: "Call project.get on a linked app with a signed request. linked is true once the app has the variable of the link. Before that, the answer has status 401 and the code CONSOLE_KEY_UNKNOWN, or 500 and CONSOLE_KEY_NOT_CONFIGURED when the app has no Console key.",
  input: z.object({ id: z.string().describe("The app id from list_apps") }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async ({ id }, { caller }) => consoleToolAnswer(await checkProject(await mcpTeamCaller(caller), id, { surface: "mcp" })),
})
