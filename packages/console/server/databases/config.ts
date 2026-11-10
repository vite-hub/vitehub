import { defineDatabase } from "vite-hub/database"

import { consoleSchema } from "../../src/projects.ts"

export default defineDatabase({
  schema: consoleSchema,
})
