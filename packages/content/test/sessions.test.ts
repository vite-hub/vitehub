import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { getTableConfig } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { contentSessionsSchema } from "../src/database.ts"
import { contentSessionTimeouts, defineContent, documents, singleton } from "../src/index.ts"

const history = await readFile(new URL("../../workspace/test/fixtures/history.sql", import.meta.url), "utf8")
const sessionsTable = await readFile(new URL("./fixtures/sessions.sql", import.meta.url), "utf8")
const cleanup: Array<() => Promise<void> | void> = []
let workspaces = 0

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function migrate(database: ReturnType<typeof drizzle>, migration: string) {
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
}

async function setup(options: { table?: boolean, lease?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-sessions-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle(client, { schema: { ...workspaceHistorySchema, ...contentSessionsSchema } })
  await migrate(database, history)
  if (options.table !== false) await migrate(database, sessionsTable)
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  const workspace = `sessions-${++workspaces}`
  registerWorkspace(workspace, { store: createBlobDatabaseWorkspaceStore({ blob, database, workspace }) })
  const content = defineContent({
    workspace,
    collections: {
      posts: documents({ path: "posts/*.md", fields: { title: z.string() }, ...(options.lease === false ? { editing: { lease: false } } : {}) }),
      notes: documents({ path: "notes/*.md", fields: { title: z.string() }, editing: { lease: false } }),
      settings: singleton({ path: "settings.json", fields: { title: z.string() } }),
    },
    logger: false,
  })
  cleanup.push(() => content.dispose())
  /** Move every session of the workspace back in time, as if `milliseconds` passed on the Database clock. */
  const elapse = async (milliseconds: number, column: "expires_at" | "last_input_at" = "expires_at") => {
    await database.run(sql.raw(`update vitehub_content_sessions set ${column} = ${column} - ${milliseconds} where workspace = '${workspace}'`))
  }
  return { content, database, elapse, posts: content.collection("posts") }
}

const ana = { id: "ana", name: "Ana", image: "https://example.com/ana.png" }
const ben = { id: "ben", name: "Ben" }
const tabA = "tab-ana-0001"
const tabB = "tab-ben-0001"

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  }
  catch (error) {
    return error
  }
  throw new Error("Expected the call to fail.")
}

describe("Content sessions", { timeout: 30_000 }, () => {
  it("ships the table that the fixture migration creates", () => {
    const config = getTableConfig(contentSessionsSchema.contentSessions)
    expect(config.name).toBe("vitehub_content_sessions")
    expect(config.columns.map(column => column.name).sort()).toEqual([
      "acquired_at", "collection", "document", "expires_at", "kind", "last_input_at", "renewed_at", "session", "user_id", "user_image", "user_name", "workspace",
    ])
    expect(contentSessionTimeouts).toEqual({ presence: 45_000, lease: 300_000, idle: 900_000 })
  })

  it("reports presence and lists who views a document", async () => {
    const { content } = await setup()
    const viewing = await content.sessions.report("posts", "hello", { session: tabA, user: ana, kind: "view" })
    expect(viewing).toMatchObject({ collection: "posts", id: "hello", editing: false, holder: null, lease: true })
    expect(viewing.sessions).toEqual([expect.objectContaining({ session: tabA, kind: "view", since: null, user: { id: "ana", name: "Ana", image: "https://example.com/ana.png" } })])
    const seen = Date.parse(viewing.sessions[0]!.seenAt)
    expect(Date.parse(viewing.sessions[0]!.expiresAt) - seen).toBe(contentSessionTimeouts.presence)
    await content.sessions.report("posts", "other", { session: tabB, user: ben, kind: "view" })
    await content.sessions.report("settings", { session: tabB, user: ben, kind: "view" })
    expect((await content.sessions.list()).map(entry => `${entry.collection}/${entry.id}:${entry.user.id}`)).toEqual(["posts/hello:ana", "posts/other:ben", "settings/settings:ben"])
    expect((await content.sessions.list("settings")).map(entry => entry.id)).toEqual(["settings"])
  })

  it("lets exactly one of two concurrent sessions acquire the lease", async () => {
    const { content } = await setup()
    const [first, second] = await Promise.all([
      content.sessions.acquire("posts", "hello", { session: tabA, user: ana }),
      content.sessions.acquire("posts", "hello", { session: tabB, user: ben }),
    ])
    expect([first.editing, second.editing].filter(Boolean)).toHaveLength(1)
    const winner = first.editing ? first : second
    const loser = first.editing ? second : first
    expect(loser.holder?.session).toBe(winner.holder?.session)
    expect(loser.sessions.find(entry => entry.session === loser.sessions.find(other => other.kind === "view")?.session)?.kind).toBe("view")
    const listed = await content.sessions.list("posts")
    expect(listed.filter(entry => entry.kind === "edit")).toHaveLength(1)
  })

  it("keeps two tabs of one user apart", async () => {
    const { content } = await setup()
    expect((await content.sessions.acquire("posts", "hello", { session: "tab-ana-0001", user: ana })).editing).toBe(true)
    const secondTab = await content.sessions.acquire("posts", "hello", { session: "tab-ana-0002", user: ana })
    expect(secondTab.editing).toBe(false)
    expect(secondTab.holder).toMatchObject({ session: "tab-ana-0001", user: { id: "ana" } })
    await expect(rejection(content.collection("posts").save("hello", { data: { title: "From tab 2" } }, { session: "tab-ana-0002" })))
      .resolves.toMatchObject({ code: "CONTENT_LEASE_HELD" })
  })

  it("renews the lease on reports and saves, and drops it when the session views", async () => {
    const { content, elapse, posts } = await setup()
    const acquired = await content.sessions.acquire("posts", "hello", { session: tabA, user: ana })
    const holder = acquired.holder!
    expect(Date.parse(holder.expiresAt) - Date.parse(acquired.now)).toBe(contentSessionTimeouts.lease)
    await elapse(200_000)
    const renewed = await content.sessions.report("posts", "hello", { session: tabA, user: ana, kind: "edit" })
    expect(renewed.editing).toBe(true)
    expect(renewed.holder!.since).toBe(holder.since)
    expect(Date.parse(renewed.holder!.expiresAt) - Date.parse(renewed.now)).toBe(contentSessionTimeouts.lease)
    await elapse(200_000)
    await posts.save("hello", { data: { title: "Hello" } }, { session: tabA })
    const [afterSave] = await content.sessions.list("posts")
    expect(Date.parse(afterSave!.expiresAt) - Date.now()).toBeGreaterThan(contentSessionTimeouts.lease - 10_000)
    const viewing = await content.sessions.report("posts", "hello", { session: tabA, user: ana, kind: "view" })
    expect(viewing).toMatchObject({ editing: false, holder: null })
    expect((await content.sessions.acquire("posts", "hello", { session: tabB, user: ben })).editing).toBe(true)
  })

  it("never claims a free lease from a report", async () => {
    const { content } = await setup()
    expect((await content.sessions.report("posts", "hello", { session: tabA, user: ana, kind: "edit", input: true })).editing).toBe(false)
    expect((await content.sessions.list()).map(entry => entry.kind)).toEqual(["view"])
  })

  it("hands the lease over with takeover, and refuses the former holder", async () => {
    const { content, posts } = await setup()
    await content.sessions.acquire("posts", "hello", { session: tabA, user: ana })
    const blocked = await content.sessions.acquire("posts", "hello", { session: tabB, user: ben })
    expect(blocked).toMatchObject({ editing: false, holder: { session: tabA, user: { name: "Ana" } } })
    const taken = await content.sessions.acquire("posts", "hello", { session: tabB, user: ben, takeover: true })
    expect(taken).toMatchObject({ editing: true, holder: { session: tabB, user: { name: "Ben" } } })
    const former = await content.sessions.report("posts", "hello", { session: tabA, user: ana, kind: "edit", input: true })
    expect(former).toMatchObject({ editing: false, holder: { session: tabB } })
    // The former holder still views the document.
    expect(former.sessions.map(entry => [entry.session, entry.kind])).toEqual([[tabB, "edit"], [tabA, "view"]])
    await expect(rejection(posts.save("hello", { data: { title: "Late edit" } }, { session: tabA }))).resolves.toMatchObject({
      code: "CONTENT_LEASE_HELD",
      details: { collection: "posts", id: "hello", holder: { user: { id: "ben", name: "Ben", image: null }, since: taken.holder!.since } },
    })
  })

  it("frees an expired lease", async () => {
    const { content, elapse } = await setup()
    await content.sessions.acquire("posts", "hello", { session: tabA, user: ana })
    await elapse(contentSessionTimeouts.lease + 1_000)
    expect(await content.sessions.list()).toEqual([])
    expect((await content.sessions.acquire("posts", "hello", { session: tabB, user: ben })).editing).toBe(true)
  })

  it("frees a lease without input for the idle window, and lets the idle session reclaim a free one", async () => {
    const { content, elapse, posts } = await setup()
    await content.sessions.acquire("posts", "hello", { session: tabA, user: ana })
    await elapse(contentSessionTimeouts.idle + 1_000, "last_input_at")
    // Reports without input keep the session present, but its idle lease no longer counts.
    const idle = await content.sessions.report("posts", "hello", { session: tabA, user: ana, kind: "edit" })
    expect(idle).toMatchObject({ editing: false, holder: null })
    await posts.save("hello", { data: { title: "Agent edit" } })
    // The next keystroke reclaims it while it is free.
    expect((await content.sessions.acquire("posts", "hello", { session: tabA, user: ana })).editing).toBe(true)
    await elapse(contentSessionTimeouts.idle + 1_000, "last_input_at")
    expect((await content.sessions.acquire("posts", "hello", { session: tabB, user: ben })).editing).toBe(true)
    expect((await content.sessions.acquire("posts", "hello", { session: tabA, user: ana })).editing).toBe(false)
  })

  it("frees the lease and presence on release", async () => {
    const { content, posts } = await setup()
    await content.sessions.acquire("posts", "hello", { session: tabA, user: ana })
    await content.sessions.release("posts", "hello", { session: tabA })
    expect(await content.sessions.list()).toEqual([])
    await expect(posts.save("hello", { data: { title: "Free" } })).resolves.toMatchObject({ id: "hello" })
  })

  it("refuses writes of other callers while a lease is held, unless they override", async () => {
    const { content, posts } = await setup()
    const saved = await posts.save("hello", { data: { title: "Hello" } })
    await content.sessions.acquire("posts", "hello", { session: tabA, user: ana })
    // The holder writes; callers without the session do not.
    const own = await posts.save("hello", { data: { title: "By Ana" } }, { session: tabA, ifDigest: saved.digest })
    for (const write of [
      () => posts.save("hello", { data: { title: "By an Agent" } }),
      () => posts.remove("hello"),
      () => posts.restore("hello", saved.revision),
      () => posts.save("hello", { data: { title: "By Ben" } }, { session: tabB }),
    ]) {
      await expect(rejection(write())).resolves.toMatchObject({
        code: "CONTENT_LEASE_HELD",
        message: expect.stringContaining("Ana is editing"),
        details: { holder: { user: { name: "Ana" } } },
      })
    }
    await expect(posts.save("hello", { data: { title: "Override" } }, { lease: "override", ifDigest: own.digest })).resolves.toMatchObject({ data: { title: "Override" } })
    // Other documents are not leased.
    await expect(posts.save("other", { data: { title: "Other" } })).resolves.toMatchObject({ id: "other" })
    await expect(rejection(posts.save("hello", { data: { title: "x" } }, { lease: "skip" as never }))).resolves.toMatchObject({ code: "CONTENT_R0008" })
  })

  it("lets several sessions edit a collection with editing: { lease: false }", async () => {
    const { content } = await setup()
    const notes = content.collection("notes")
    expect(notes.editing).toEqual({ lease: false })
    expect(content.collection("posts").editing).toEqual({ lease: true })
    const first = await content.sessions.acquire("notes", "today", { session: tabA, user: ana })
    const second = await content.sessions.acquire("notes", "today", { session: tabB, user: ben })
    expect(first).toMatchObject({ editing: true, holder: null, lease: false })
    expect(second).toMatchObject({ editing: true, holder: null, lease: false })
    expect(second.sessions.map(entry => entry.kind)).toEqual(["edit", "edit"])
    await expect(notes.save("today", { data: { title: "Agent" } })).resolves.toMatchObject({ id: "today" })
    await expect(notes.save("today", { data: { title: "Ana" } }, { session: tabA })).resolves.toMatchObject({ id: "today" })
    const viewing = await content.sessions.report("notes", "today", { session: tabA, user: ana, kind: "view" })
    expect(viewing.sessions.map(entry => [entry.session, entry.kind])).toEqual([[tabB, "edit"], [tabA, "view"]])
  })

  it("leases singletons without an id", async () => {
    const { content } = await setup()
    expect((await content.sessions.acquire("settings", { session: tabA, user: ana })).editing).toBe(true)
    await expect(rejection(content.collection("settings").save({ data: { title: "Site" } }))).resolves.toMatchObject({ code: "CONTENT_LEASE_HELD" })
    await content.sessions.release("settings", { session: tabA })
    await expect(content.collection("settings").save({ data: { title: "Site" } })).resolves.toMatchObject({ id: "settings" })
  })

  it("validates sessions input", async () => {
    const { content } = await setup()
    await expect(rejection(content.sessions.report("posts", "hello", { session: "short", user: ana, kind: "view" }))).resolves.toMatchObject({ code: "CONTENT_R0008" })
    await expect(rejection(content.sessions.report("posts", "hello", { session: tabA, user: { id: "" }, kind: "view" }))).resolves.toMatchObject({ code: "CONTENT_R0008" })
    await expect(rejection(content.sessions.report("posts", "hello", { session: tabA, user: ana, kind: "write" as never }))).resolves.toMatchObject({ code: "CONTENT_R0008" })
    await expect(rejection(content.sessions.report("missing" as never, "hello", { session: tabA, user: ana, kind: "view" }))).resolves.toMatchObject({ code: "CONTENT_R0008" })
    await expect(rejection(content.sessions.report("posts", "../escape", { session: tabA, user: ana, kind: "view" }))).resolves.toMatchObject({ code: "CONTENT_R0008" })
  })

  it("names the fix when the Database has no sessions table, and keeps saving", async () => {
    const { content, posts } = await setup({ table: false })
    const error = await rejection(content.sessions.report("posts", "hello", { session: tabA, user: ana, kind: "view" }))
    expect(error).toMatchObject({ code: "CONTENT_R0012" })
    expect(String(Reflect.get(Object(error), "message"))).toContain("contentSessionsSchema from 'vite-hub/content/database'")
    await expect(rejection(content.sessions.list())).resolves.toMatchObject({ code: "CONTENT_R0012" })
    await expect(posts.save("hello", { data: { title: "Hello" } }, { session: tabA })).resolves.toMatchObject({ id: "hello" })
    await expect(posts.save("hello", { data: { title: "Hello again" } })).resolves.toMatchObject({ data: { title: "Hello again" } })
  })
})
