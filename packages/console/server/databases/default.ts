import { defineDatabase } from "vite-hub/database"

import { consoleSchema } from "../../src/projects.ts"
import { consoleSiteSchema } from "../../src/site-access.ts"

export default defineDatabase({
  schema: { ...consoleSchema, ...consoleSiteSchema },
  cloudflare: {
    binding: "DB",
    databaseName: process.env.VITEHUB_CONSOLE_D1_NAME ?? "vitehub-console",
    databaseId: process.env.VITEHUB_CONSOLE_D1_ID,
  },
})
