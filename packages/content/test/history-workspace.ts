import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"

import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"

const migration = await readFile(new URL("../../workspace/test/fixtures/history.sql", import.meta.url), "utf8")
const sessionsMigration = await readFile(new URL("./fixtures/sessions.sql", import.meta.url), "utf8")
let workspaces = 0

/**
 * Register a Workspace on the Blob + Database Store over libSQL, as the Workspace history tests use.
 * Content and the Content Agent Capability tests share it. `cleanup` receives the disposers to run after the test.
 * `sessions` also creates the `content.sessions` table, for edit leases.
 */
export async function historyWorkspace(cleanup: Array<() => Promise<void> | void>, options: { sessions?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle(client, { schema: workspaceHistorySchema })
  for (const statement of (options.sessions ? `${migration};${sessionsMigration}` : migration).split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  const name = `site-${process.pid}-${++workspaces}`
  registerWorkspace(name, { store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: name }) })
  return name
}
