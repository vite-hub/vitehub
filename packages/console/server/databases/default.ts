import { defineDatabase } from "vite-hub/database"

import { consoleSchema } from "../../src/projects.ts"

export default defineDatabase({
  schema: consoleSchema,
  cloudflare: {
    binding: "DB",
    databaseName: process.env.VITEHUB_CONSOLE_D1_NAME ?? "vitehub-console",
    databaseId: process.env.VITEHUB_CONSOLE_D1_ID,
  },
})
