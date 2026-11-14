import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { getTableConfig } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"
import { useWorkspace } from "@vite-hub/workspace"
import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { pullWorkspaces, pushWorkspaces } from "@vite-hub/workspace/checkout"
import { workspaceOperations } from "../../workspace/src/operations.ts"
import { registerWorkspace } from "@vite-hub/workspace/test"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { contentSessionsSchema } from "../src/database.ts"
import { documents, singleton } from "../src/collections.ts"
import { contentSessionTimeouts, defineContent } from "../src/index.ts"

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
  const database = drizzle({ client })
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
  return { content, database, elapse, posts: content.collection("posts"), workspace }
}

const ana = { id: "ana", name: "Ana", image: "https://example.com/ana.png" }
const ben = { id: "ben", name: "Ben" }
const tabA = "tab-ana-0001"
const tabB = "tab-ben-0001"

const post = (title: string, body = "") => `---\ntitle: ${title}\n---\n${body}`
const cli = { access: { mode: "local", sections: "all" }, surface: "cli", user: null } as const

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
    // The claim sets the start and the end of the lease in one statement, so both use the same Database clock.
    expect(Date.parse(holder.expiresAt) - Date.parse(holder.since!)).toBe(contentSessionTimeouts.lease)
    await elapse(200_000)
    const renewed = await content.sessions.report("posts", "hello", { session: tabA, user: ana, kind: "edit" })
    expect(renewed.editing).toBe(true)
    expect(renewed.holder!.since).toBe(holder.since)
    // `now` is read in a later statement of the batch, so it can be a millisecond or two past the renewal.
    const remaining = Date.parse(renewed.holder!.expiresAt) - Date.parse(renewed.now)
    expect(remaining).toBeLessThanOrEqual(contentSessionTimeouts.lease)
    expect(remaining).toBeGreaterThan(contentSessionTimeouts.lease - 1_000)
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

  it("refuses other Workspace writes to the draft of a leased document, and lets Content's own writes through", async () => {
    const { content, elapse, posts, workspace } = await setup()
    const { history } = useWorkspace(workspace as never, { mode: "write" })
    // The draft does not exist yet: the holder's first save seeds it from published, which writes the leased document.
    await history.commit({ ref: "published", ifHead: null, files: { "posts/hello.md": post("Published"), "posts/other.md": post("Other") } })
    await content.sessions.acquire("posts", "hello", { session: tabA, user: ana })
    const saved = await posts.save("hello", { data: { title: "By Ana" } }, { session: tabA })
    const head = (await history.head({ ref: "draft" }))!

    const error = await rejection(history.commit({ ref: "draft", ifHead: head.id, changes: { put: { "posts/hello.md": post("Raw"), "posts/new.md": post("New") } } }))

    expect(error).toMatchObject({
      code: "CONTENT_LEASE_HELD",
      message: "[vitehub] Ana is editing Content document \"posts/hello\". Nothing was saved.",
      status: 409,
      fix: expect.stringContaining("vitehub push --override-lease"),
      details: { collection: "posts", id: "hello", holder: { kind: "edit", user: { name: "Ana" } }, documents: [{ collection: "posts", id: "hello" }] },
    })
    await expect(rejection(history.commit({ ref: "draft", ifHead: head.id, changes: { delete: ["posts/hello.md"] } }))).resolves.toMatchObject({ code: "CONTENT_LEASE_HELD" })
    expect((await history.head({ ref: "draft" }))!.id).toBe(head.id)
    // A document without a lease, the published ref, and a collection with editing: { lease: false } take the write.
    const other = await history.commit({ ref: "draft", ifHead: head.id, changes: { put: { "posts/other.md": post("Raw other"), "notes/today.md": post("Note") } } })
    await content.sessions.acquire("notes", "today", { session: tabB, user: ben })
    const note = await history.commit({ ref: "draft", ifHead: other.id, changes: { put: { "notes/today.md": post("Note 2") } } })

    // Content's own writes: the holder saves, and a publish of the leased document lands.
    const own = await posts.save("hello", { data: { title: "By Ana again" } }, { session: tabA, ifDigest: saved.digest })
    await expect(content.publish({ expect: [{ collection: "posts", id: "hello", digest: own.digest }] })).resolves.toMatchObject({ documents: [{ id: "hello" }] })

    // lease: "override" in the revision metadata writes anyway, and the revision records it.
    const draft = (await history.head({ ref: "draft" }))!
    expect(draft.id).not.toBe(note.id)
    const overridden = await history.commit({ ref: "draft", ifHead: draft.id, changes: { put: { "posts/hello.md": post("Override") } }, metadata: { lease: "override" } })
    expect(overridden.metadata).toEqual({ lease: "override" })
    expect((await posts.get("hello", { ref: "draft" }))!.data).toEqual({ title: "Override" })

    // An idle lease does not hold.
    await elapse(contentSessionTimeouts.idle + 1_000, "last_input_at")
    await expect(history.commit({ ref: "draft", ifHead: overridden.id, changes: { put: { "posts/hello.md": post("After idle") } } })).resolves.toMatchObject({ ref: "draft" })
  })

  it("names every leased document of one commit", async () => {
    const { content, posts, workspace } = await setup()
    await posts.save("a", { data: { title: "A" } })
    await posts.save("b", { data: { title: "B" } })
    await content.sessions.acquire("posts", "a", { session: tabA, user: ana })
    await content.sessions.acquire("posts", "b", { session: tabB, user: ben })
    await content.sessions.acquire("settings", { session: "tab-ana-0002", user: ana })
    const { history } = useWorkspace(workspace as never, { mode: "write" })
    const head = (await history.head({ ref: "draft" }))!

    const error = await rejection(history.commit({ ref: "draft", ifHead: head.id, changes: { put: { "posts/a.md": post("A2"), "posts/b.md": post("B2"), "posts/c.md": post("C"), "settings.json": "{\"title\":\"Site\"}" } } }))

    expect(error).toMatchObject({
      code: "CONTENT_LEASE_HELD",
      message: "[vitehub] Other sessions are editing 3 Content documents: \"posts/a\" (Ana), \"posts/b\" (Ben), \"settings/settings\" (Ana). Nothing was saved.",
      details: { collection: "posts", id: "a", documents: [{ id: "a", holder: { user: { name: "Ana" } } }, { id: "b", holder: { user: { name: "Ben" } } }, { collection: "settings", id: "settings" }] },
    })
  })

  it("fails vitehub push to a leased document, and pushes it with --override-lease", async () => {
    const { content, posts, workspace } = await setup()
    await posts.save("hello", { data: { title: "Hello" } })
    await posts.save("other", { data: { title: "Other" } })
    const registry = createOperationRegistry([{ operations: workspaceOperations }])
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-content-push-"))
    cleanup.push(() => rm(rootDir, { recursive: true, force: true }))
    const commits: unknown[] = []
    const checkout = {
      rootDir,
      call: async (operation: string, input: unknown) => {
        if (operation === "workspace.commit") commits.push(input)
        return await runOperation(registry, operation, input, cli)
      },
    }
    await pullWorkspaces(checkout, { workspace, dir: "content", ref: "draft" })
    await content.sessions.acquire("posts", "hello", { session: tabA, user: ana })
    await writeFile(join(rootDir, "content/posts/hello.md"), post("Local"))
    await writeFile(join(rootDir, "content/posts/other.md"), post("Local other"))
    const head = (await useWorkspace(workspace as never).history.head({ ref: "draft" }))!

    const error = await rejection(pushWorkspaces(checkout, { workspace }))

    expect(error).toMatchObject({ code: "CONTENT_LEASE_HELD", message: "[vitehub] Ana is editing Content document \"posts/hello\". Nothing was saved.", fix: expect.stringContaining("--override-lease") })
    // A held lease is not a moved head: the push does not try again, and the draft keeps its head.
    expect(commits).toHaveLength(1)
    expect((await useWorkspace(workspace as never).history.head({ ref: "draft" }))!.id).toBe(head.id)
    const agent = { ...cli, surface: "agent" as const }
    await expect(runOperation(registry, "workspace.commit", { workspace, ref: "draft", ifHead: head.id, lease: "override", put: { "posts/hello.md": { content: post("Agent"), encoding: "utf8" } } }, agent))
      .resolves.toMatchObject({ ok: false, code: "WORKSPACE_FORBIDDEN", status: 403 })

    const [pushed] = await pushWorkspaces(checkout, { workspace, overrideLease: true })

    expect(pushed).toMatchObject({ pushed: ["posts/hello.md", "posts/other.md"] })
    const revision = (await useWorkspace(workspace as never).history.head({ ref: "draft" }))!
    expect(revision).toMatchObject({ id: pushed!.revision, metadata: { lease: "override", source: "cli" } })
    expect((await posts.get("hello", { ref: "draft" }))!.data).toEqual({ title: "Local" })
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
