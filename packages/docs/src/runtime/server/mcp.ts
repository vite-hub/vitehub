import { defineContentMcpHandler } from "@vite-hub/content"

import type { ContentHandler } from "@vite-hub/content"
import { docsContent } from "../content.ts"

/** The docs MCP server at `/mcp`, with the `list-pages` and `get-page` tools of Content. */
const handler: ContentHandler = { fetch: request => defineContentMcpHandler(docsContent()).fetch(request) }

export default handler
