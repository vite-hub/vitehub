import { defineDatabase } from "vite-hub/database"

import { consoleHostedCommentsSchema } from "../../src/hosted-comments-schema.ts"
import { consoleCommentSessionSchema } from "../../src/hosted-comments-session.ts"
import { consoleSchema } from "../../src/projects.ts"
import { consoleSiteSchema } from "../../src/site-access.ts"

export default defineDatabase({
  schema: { ...consoleSchema, ...consoleSiteSchema, ...consoleHostedCommentsSchema, ...consoleCommentSessionSchema },
  cloudflare: {
    binding: "DB",
    databaseName: process.env.VITEHUB_CONSOLE_D1_NAME ?? "vitehub-console",
    databaseId: process.env.VITEHUB_CONSOLE_D1_ID,
  },
})
