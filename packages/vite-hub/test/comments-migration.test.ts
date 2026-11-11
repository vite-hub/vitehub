import { readFileSync } from "node:fs"

import { commentsSchema } from "@vite-hub/comments/database"
import { generateDrizzleJson, generateMigration } from "drizzle-kit/payload/sqlite"
import { expect, it } from "vitest"

type Snapshot = Awaited<ReturnType<typeof generateDrizzleJson>>
type SnapshotEntity = Snapshot["ddl"][number]

const owner = (entity: SnapshotEntity) => "table" in entity ? entity.table : entity.name
const key = (entity: SnapshotEntity) => `${entity.entityType}:${owner(entity)}:${entity.name}`
const sorted = (entities: readonly SnapshotEntity[]) => [...entities].sort((a, b) => key(a).localeCompare(key(b)))

it("records the current Comments schema after the playground migrations", async () => {
  // SAFETY: Drizzle Kit wrote this snapshot.json; `generateMigration` validates its shape.
  const snapshot = JSON.parse(readFileSync(new URL("../../../playground/content/server/databases/content/migrations/20261109045320_comments_request_id/snapshot.json", import.meta.url), "utf8")) as Snapshot
  snapshot.ddl = snapshot.ddl.filter(entity => owner(entity).startsWith("vitehub_comment"))
  const declared = await generateDrizzleJson(commentsSchema)
  expect(sorted(snapshot.ddl)).toEqual(sorted(declared.ddl))
  expect(await generateMigration(snapshot, declared)).toEqual([])
})
