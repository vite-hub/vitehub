import { defineContentLlmsHandler } from "@vite-hub/content"

import type { ContentHandler } from "@vite-hub/content"
import { docsContent } from "../content.ts"

/** `/llms.txt`, `/llms-full.txt`, and `/sitemap.md`, from Content. The build prerenders them. */
const handler: ContentHandler = { fetch: request => defineContentLlmsHandler(docsContent()).fetch(request) }

export default handler
