import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { callDocsTool } from "../../../src/docs-mcp.ts"

export default defineMcpTool({
  title: "List Pages",
  description: "Finds documentation pages by their title, path, and description, and returns each page's title, path, description, and URL. Use it only for questions about ViteHub.\n\nPass query, a few words such as \"rate limit\" or an error code, to get the 20 best matches first. Without query it lists the pages in site order, 100 per call. Pass offset to read the next pages. Then read a page with get-page. When you already know the path or URL of a page, call get-page directly.",
  input: z.object({
    query: z.string().max(200).optional().describe("Words to look for, such as \"rate limit\" or an error code. The best matches come first."),
    offset: z.number().int().min(0).optional().describe("Pages to skip, for the pages after the first call. Defaults to 0."),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  access: "public",
  handler: ({ query, offset }) => callDocsTool("list-pages", { ...query === undefined ? {} : { query }, ...offset === undefined ? {} : { offset } }),
})
