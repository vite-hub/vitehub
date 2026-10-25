import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"
import { operationCliPath } from "@vite-hub/internal/operations"

import { consoleDatabaseKey, consoleDatabaseRegistryKey, consoleDatabaseRootKey } from "../src/console/internal.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { installConsoleDatabase } from "../src/console/runtime/server/database.ts"
import { consoleOperations } from "../src/console/runtime/server/operations.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"

const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
})
const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  authorId: integer("author_id").notNull().references(() => users.id),
  title: text("title").notNull(),
})
const schema = { posts, users }
const clients: Array<ReturnType<typeof createClient>> = []

async function install(): Promise<void> {
  const client = createClient({ url: "file::memory:" })
  clients.push(client)
  const db = drizzle({ client, schema })
  await client.execute("create table users (id integer primary key autoincrement, email text not null unique)")
  await client.execute("create table posts (id integer primary key autoincrement, author_id integer not null references users(id), title text not null)")
  await db.insert(users).values([{ email: "ada@example.com" }, { email: "grace@example.com" }, { email: "linus@example.com" }])
  await db.insert(posts).values({ authorId: 1, title: "First" })
  installConsoleDatabase("/project", { default: { db, schema } }, ["default"])
}

function call(operation: string, input: unknown = {}, headers: Record<string, string> = {}) {
  return handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/__call", {
    body: JSON.stringify({ input, operation }),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1", ...headers },
    method: "POST",
  }))
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  for (const scope of [globalThis, process]) {
    for (const key of [consoleDatabaseKey, consoleDatabaseRegistryKey, consoleDatabaseRootKey]) Reflect.deleteProperty(scope, key)
  }
  installConsoleAccess({ mode: "open" })
  installConsoleOperations([])
})

describe("database operations", () => {
  it("puts the table commands under `vitehub db`", () => {
    const paths = consoleOperations.filter(operation => operation.name.startsWith("databases.")).map(operation => ({ name: operation.name, ...operationCliPath(operation) }))
    expect(paths).toEqual([
      { command: "rows", name: "databases.browse", namespace: "db" },
      { command: "tables", name: "databases.tables", namespace: "db" },
    ])
  })

  it("lists the tables with their columns and relationships, and no rows", async () => {
    await install()

    const response = await call("databases.tables")

    expect(response.status).toBe(200)
    const { value } = await response.json() as { value: Record<string, unknown> }
    expect(Object.keys(value).sort()).toEqual(["database", "databases", "relationships", "tables"])
    expect(value).toMatchObject({
      database: "default",
      databases: ["default"],
      relationships: [{ from: { column: "author_id", table: "posts" }, to: { column: "id", table: "users" } }],
    })
    expect((value.tables as Array<{ name: string }>).map(table => table.name)).toEqual(["posts", "users"])
  })

  it("reads one page of rows, sorted and searched, and caps the limit", async () => {
    await install()

    const page = await (await call("databases.browse", { direction: "desc", limit: 2, sort: "email", table: "users" })).json() as { value: { rows: Array<Record<string, { value: string }>>, total: number } }
    expect(page.value.total).toBe(3)
    expect(page.value.rows.map(row => row.email!.value)).toEqual(["linus@example.com", "grace@example.com"])

    const search = await (await call("databases.browse", { search: "ada", table: "users" })).json() as { value: { rows: unknown[], total: number } }
    expect(search.value).toMatchObject({ total: 1 })

    const capped = await call("databases.browse", { limit: 1_000, table: "users" })
    expect(capped.status).toBe(400)
  })

  it("fails a command that names a table that does not exist, but not the Console page", async () => {
    await install()

    const cli = await call("databases.browse", { table: "missing" }, { "x-vitehub-surface": "cli" })
    expect(cli.status).toBe(404)
    await expect(cli.json()).resolves.toMatchObject({ message: 'The database has no table "missing".', ok: false })

    const console_ = await call("databases.browse", { table: "missing" })
    expect(console_.status).toBe(200)
  })

  it("reads under a read-only grant and is denied without the section", async () => {
    await install()

    installConsoleAccess({ authorize: () => ({ sections: ["databases:read"] }), mode: "open" })
    expect((await call("databases.tables")).status).toBe(200)
    expect((await call("databases.browse", { table: "users" })).status).toBe(200)

    installConsoleAccess({ authorize: () => ({ sections: ["kv"] }), mode: "open" })
    expect((await call("databases.tables")).status).toBe(403)
    expect((await call("databases.browse", { table: "users" })).status).toBe(403)
  })
})

describe("usage operation", () => {
  it("reads the Usage section, and is `vitehub usage get`", () => {
    const usage = consoleOperations.find(operation => operation.name === "usage.get")
    expect(usage).toMatchObject({ kind: "read", section: "usage" })
    expect(usage && operationCliPath(usage)).toEqual({ command: "get", namespace: "usage" })
  })
})
