import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { inspectDatabaseDefinitions } from "../src/inspect.ts"
import { cloudflareOptions, mergeCloudflareConfig } from "../src/internal/cloudflare.ts"
import { createDrizzleSqliteAdapter } from "../src/runtime/drizzle-adapter.ts"
import { d1BookmarkCookieName, runWithDatabaseRequest } from "../src/runtime/d1-sessions.ts"

const schema = {
  notes: sqliteTable("notes", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
  }),
}

/** A D1 binding that records which client ran each query and which constraint opened each session. */
function createReplicatedD1() {
  const queries: string[] = []
  const constraints: string[] = []
  const client = (name: string) => ({
    batch: async () => [],
    prepare(query: string) {
      return {
        bind() {
          return {
            all: async () => {
              queries.push(`${name}: ${query}`)
              return { results: [] }
            },
            raw: async () => {
              queries.push(`${name}: ${query}`)
              return []
            },
            run: async () => {
              queries.push(`${name}: ${query}`)
              return {}
            },
          }
        },
      }
    },
  })
  let sessions = 0
  const binding = {
    ...client("primary"),
    withSession(constraint: string) {
      constraints.push(constraint)
      const bookmark = `bookmark-${++sessions}`
      return { ...client(`session ${sessions}`), getBookmark: () => bookmark }
    },
  }
  return { binding, constraints, queries }
}

function createDb(readReplication: boolean | undefined) {
  return createDrizzleSqliteAdapter({
    cloudflare: { binding: "DB", ...(readReplication === undefined ? {} : { readReplication }) },
    drizzle: {},
    name: "default",
  }, schema, { missingConnection: "a D1 binding", requireRemoteUrl: true })
}

function createEvent(method: string, cookie?: string, url = "https://app.example/api/notes") {
  return {
    req: new Request(url, { method, headers: cookie ? { cookie } : {} }),
    res: { headers: new Headers() },
  }
}

async function inRequest<T>(binding: object, event: ReturnType<typeof createEvent>, callback: () => Promise<T>) {
  return await runWithActiveCloudflareEnv({ DB: binding }, () => runWithDatabaseRequest(event, callback))
}

describe("D1 read replication", () => {
  it("reads a GET from any replica and sets no cookie", async () => {
    const { binding, constraints, queries } = createReplicatedD1()
    const db = createDb(true)
    const event = createEvent("GET")
    await inRequest(binding, event, async () => {
      await db.select().from(schema.notes)
      await db.select().from(schema.notes)
    })
    expect(constraints).toEqual(["first-unconstrained"])
    expect(queries).toEqual([
      "session 1: select \"id\", \"title\" from \"notes\"",
      "session 1: select \"id\", \"title\" from \"notes\"",
    ])
    expect(event.res.headers.get("set-cookie")).toBeNull()
  })

  it("starts a write on the primary and carries its bookmark to the next read", async () => {
    const { binding, constraints } = createReplicatedD1()
    const db = createDb(true)
    const write = createEvent("POST")
    await inRequest(binding, write, async () => {
      await db.insert(schema.notes).values({ title: "First" })
    })
    const cookie = write.res.headers.get("set-cookie")
    expect(cookie).toBe(`${d1BookmarkCookieName("DB")}=bookmark-1; Path=/; HttpOnly; SameSite=Lax; Secure`)

    const read = createEvent("GET", cookie!.split(";")[0])
    await inRequest(binding, read, async () => {
      await db.select().from(schema.notes)
    })
    expect(constraints).toEqual(["first-primary", "bookmark-1"])
  })

  it("routes direct $client queries through the request's session", async () => {
    const { binding, constraints, queries } = createReplicatedD1()
    const db = createDb(true)
    await inRequest(binding, createEvent("GET"), async () => {
      const client = (db as unknown as { $client: ReturnType<typeof createReplicatedD1>["binding"] }).$client
      await client.prepare("select 1").bind().all()
    })
    expect(constraints).toEqual(["first-unconstrained"])
    expect(queries).toEqual(["session 1: select 1"])
  })

  it("leaves Secure off over plain HTTP", async () => {
    const { binding } = createReplicatedD1()
    const db = createDb(true)
    const event = createEvent("DELETE", undefined, "http://localhost:3000/api/notes/1")
    await inRequest(binding, event, async () => {
      await db.delete(schema.notes)
    })
    expect(event.res.headers.get("set-cookie")).toBe(`${d1BookmarkCookieName("DB")}=bookmark-1; Path=/; HttpOnly; SameSite=Lax`)
  })

  it("uses the binding without sessions when read replication is off or no request is active", async () => {
    const off = createReplicatedD1()
    await inRequest(off.binding, createEvent("GET"), async () => {
      await createDb(undefined).select().from(schema.notes)
    })
    expect(off.constraints).toEqual([])
    expect(off.queries).toEqual(["primary: select \"id\", \"title\" from \"notes\""])

    const outside = createReplicatedD1()
    await runWithActiveCloudflareEnv({ DB: outside.binding }, async () => {
      await createDb(true).select().from(schema.notes)
    })
    expect(outside.constraints).toEqual([])
    expect(outside.queries).toEqual(["primary: select \"id\", \"title\" from \"notes\""])
  })

  it("uses the binding when it has no Sessions API", async () => {
    const { binding, queries } = createReplicatedD1()
    const { withSession: _, ...plain } = binding
    await inRequest(plain, createEvent("POST"), async () => {
      await createDb(true).select().from(schema.notes)
    })
    expect(queries).toEqual(["primary: select \"id\", \"title\" from \"notes\""])
  })

  it("gives each request its own session", async () => {
    const { binding, constraints } = createReplicatedD1()
    const db = createDb(true)
    await Promise.all([
      inRequest(binding, createEvent("GET", `${d1BookmarkCookieName("DB")}=bookmark-a`), () => db.select().from(schema.notes)),
      inRequest(binding, createEvent("GET"), () => db.select().from(schema.notes)),
    ])
    expect(constraints.sort()).toEqual(["bookmark-a", "first-unconstrained"])
  })

  it("inherits the integration option and lets a Definition turn it off", () => {
    const defaults = cloudflareOptions({ driver: "d1", databaseName: "app", readReplication: true })
    expect(defaults).toEqual({ databaseName: "app", readReplication: true })
    expect(mergeCloudflareConfig(defaults, { binding: "DB" })?.readReplication).toBe(true)
    expect(mergeCloudflareConfig(defaults, { readReplication: false })?.readReplication).toBe(false)
  })

  it("says in inspect output when a Database reads from replicas", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-replication-"))
    try {
      await mkdir(join(rootDir, "server", "databases"), { recursive: true })
      await writeFile(join(rootDir, "server", "databases", "config.ts"), [
        "import { defineDatabase } from '@vite-hub/database'",
        "export default defineDatabase({ cloudflare: { readReplication: true }, schema: {} })",
        "",
      ].join("\n"), "utf8")
      const [definition] = await inspectDatabaseDefinitions({ projectRoot: rootDir, rootDir })
      expect(definition?.fields).toContainEqual(expect.objectContaining({ label: "Read replication" }))

      await writeFile(join(rootDir, "server", "databases", "config.ts"), "import { defineDatabase } from '@vite-hub/database'\nexport default defineDatabase({ schema: {} })\n", "utf8")
      const [inherited] = await inspectDatabaseDefinitions({ projectRoot: rootDir, readReplication: true, rootDir })
      expect(inherited?.fields).toContainEqual(expect.objectContaining({ label: "Read replication" }))
      const [plain] = await inspectDatabaseDefinitions({ projectRoot: rootDir, rootDir })
      expect(plain?.fields.map(field => field.label)).not.toContain("Read replication")
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })
})
