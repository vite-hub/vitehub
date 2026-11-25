import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { linkProject } from "../../utils/console.ts"
import { consoleToolAnswer, mcpTeamCaller } from "../../utils/mcp.ts"

import type { ConsoleProject } from "../../../src/projects.ts"

export default defineMcpTool({
  title: "Link an app",
  description: "Link a deployed ViteHub app to your team. Only owners and admins of the team may link. If the team linked the same URL as an app and the Console can open its signing key, the answer returns the same link and key. The answer has the variable line with the public key of the link: add it to the app's environment, set console: true in its vitehub config, deploy, then call check_app. With kind: \"site\", it registers a site for Hosted Comments or returns the existing site link, and the answer has the script tag to add to the site's pages.",
  input: z.object({
    url: z.string().describe("The https:// URL of the app, with its base path if it has one, such as https://app.example.com"),
    label: z.string().optional().describe("A name for the app in the Console"),
    kind: z.literal("site").optional().describe("\"site\" registers a site that is not a ViteHub app, for Hosted Comments. A site has no key."),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (input, { caller, event }) => {
    const member = await mcpTeamCaller(caller)
    // SAFETY: A `200` or `201` of `linkProject()` has the project.
    const { project } = await consoleToolAnswer(await linkProject(member, input)) as { project: ConsoleProject }
    if (project.keyVariable === null) {
      return {
        app: project,
        script: `<script type="module" src="${new URL(event.req.url).origin}/hosted-comments.js" data-vitehub-comments="${project.id}"></script>`,
        next: `Add the script to the HTML of ${project.url} and of the pages to review, then open ${project.url}?vitehub and choose Comments.`,
      }
    }
    return {
      app: project,
      variable: `${project.keyVariable}=${project.publicKey}`,
      next: `Set ${project.keyVariable} in the environment of ${project.url}, with console: true in its vitehub config. Deploy it, then call check_app with id ${project.id}.`,
    }
  },
})
