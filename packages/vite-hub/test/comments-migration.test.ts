import { readFileSync } from "node:fs"

import { commentsSchema } from "@vite-hub/comments/database"
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api"
import { expect, it } from "vitest"

it("records the current Comments schema after the playground custom migration", async () => {
  const snapshot = JSON.parse(readFileSync(new URL("../../../playground/content/server/databases/content/migrations/meta/0007_snapshot.json", import.meta.url), "utf8"))
  snapshot.tables = Object.fromEntries(Object.entries(snapshot.tables).filter(([name]) => name.startsWith("vitehub_comment")))
  const declared = await generateSQLiteDrizzleJson(commentsSchema)
  expect(snapshot.tables).toEqual(declared.tables)
  expect(await generateSQLiteMigration(snapshot, declared)).toEqual([])
})
