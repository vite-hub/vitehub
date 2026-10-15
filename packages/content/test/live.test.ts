import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { isRealtimeDocumentConflict } from "@vite-hub/realtime"
import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { contentSessionsSchema } from "../src/database.ts"
import { defineContent, documents, singleton } from "../src/index.ts"
import { contentDocument, contentLiveSession, contentLiveTarget, contentRealtime, installContentLive } from "../src/realtime.ts"
import { createContentConsoleActions } from "../src/runtime/console.ts"

import type { RealtimeAuthorizeContext, RealtimeDocumentContext } from "@vite-hub/realtime"

const history = await readFile(new URL("../../workspace/test/fixtures/history.sql", import.meta.url), "utf8")
const sessionsTable = await readFile(new URL("./fixtures/sessions.sql", import.meta.url), "utf8")
const cleanup: Array<() => Promise<void> | void> = []
let workspaces = 0
const liveKey = Symbol.for("vitehub.content.live")

afterEach(async () => {
  Reflect.deleteProperty(globalThis, liveKey)
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function migrate(database: ReturnType<typeof drizzle>, migration: string) {
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
}

async function setup(options: { live?: "auto" | false, table?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-live-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle(client, { schema: { ...workspaceHistorySchema, ...contentSessionsSchema } })
  await migrate(database, history)
  if (options.table !== false) await migrate(database, sessionsTable)
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  const workspace = `live-${++workspaces}`
  registerWorkspace(workspace, { store: createBlobDatabaseWorkspaceStore({ blob, database, workspace }) })
  const content = defineContent({
    workspace,
    collections: {
      posts: documents({
        path: "posts/**/*.md",
        fields: { title: z.string().min(1, "Add a title."), tags: z.array(z.string()).default([]) },
        components: { alert: { props: { type: { type: "string", default: "info" } } } },
      }),
      about: singleton({ path: "about.md", fields: { title: z.string() } }),
      authors: documents({ path: "authors/*.json", fields: { name: z.string() } }),
    },
    authorize: ({ user, action }) => user?.id === "ana" || (user?.id === "ben" && action !== "publish") || (user?.id === "viewer" && action === "read"),
    live: options.live,
    logger: false,
  })
  cleanup.push(() => content.dispose())
  return { content, posts: content.collection("posts") }
}

const ana = { id: "ana", name: "Ana", image: "https://example.com/ana.png" }
const ben = { id: "ben", name: "Ben" }

function context(documentId: string): RealtimeDocumentContext {
  return { authority: "memory", definition: "content", documentId }
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  }
  catch (error) {
    return error
  }
  throw new Error("Expected the call to fail.")
}

describe("Content live leases", { timeout: 30_000 }, () => {
  it("lets a live room hold the lease for everyone in it, and refuses other writers until it releases", async () => {
    const { content, posts } = await setup()
    await posts.save("hello", { data: { title: "Hello" }, body: "Hi" })
    const session = await contentLiveSession("posts", "hello")
    expect(session).toMatch(/^live-[\da-f]{32}$/)
    const held = await content.sessions.acquire("posts", "hello", { kind: "live", session, user: { id: `live:${session}`, name: "Ana, Ben" } })
    expect(held).toMatchObject({ editing: true, holder: { kind: "live", session, user: { name: "Ana, Ben" } } })

    // A single editor sees the room and joins it instead of taking over.
    const single = await content.sessions.acquire("posts", "hello", { session: "tab-cleo-0001", user: { id: "cleo", name: "Cleo" } })
    expect(single).toMatchObject({ editing: false, holder: { kind: "live", user: { name: "Ana, Ben" } } })
    const refused = await rejection(posts.save("hello", { data: { title: "Agent" }, body: "Agent" }))
    expect(refused).toMatchObject({ code: "CONTENT_LEASE_HELD", details: { holder: { kind: "live" } } })
    expect((refused as Error).message).toContain("A live session (Ana, Ben) is editing")
    // The room's own saves pass, and renew its lease.
    await posts.save("hello", { data: { title: "Room" }, body: "Room" }, { session })
    expect((await content.sessions.list("posts")).find(entry => entry.session === session)?.kind).toBe("live")

    await content.sessions.release("posts", "hello", { session })
    expect((await content.sessions.acquire("posts", "hello", { session: "tab-cleo-0001", user: { id: "cleo", name: "Cleo" } })).editing).toBe(true)
  })

  it("rejects an unknown acquire kind", async () => {
    const { content } = await setup()
    await expect(rejection(content.sessions.acquire("posts", "hello", { kind: "view" as never, session: "tab-ana-0001", user: ana })))
      .resolves.toMatchObject({ code: "CONTENT_R0008" })
  })
})

describe("contentDocument", { timeout: 30_000 }, () => {
  it("loads the draft fields, the body without frontmatter, and the draft digest", async () => {
    const { posts } = await setup()
    const saved = await posts.save("2026/hello", { data: { title: "Hello", tags: ["news"] }, body: "# Hello\n\nFirst." })
    const adapter = contentDocument(posts)
    await expect(adapter.load(context("2026/hello"))).resolves.toEqual({ body: "# Hello\n\nFirst.", digest: saved.digest, fields: { tags: ["news"], title: "Hello" } })
    await expect(adapter.load(context("missing"))).resolves.toEqual({ body: "", digest: null, fields: {} })
  })

  it("saves into the draft with ifDigest, keeps invalid fields as issues, and names the editors", async () => {
    const { content, posts } = await setup()
    const first = await posts.save("hello", { data: { title: "Hello" }, body: "Hi" })
    const adapter = contentDocument(posts, { sessions: content.sessions })

    const result = await adapter.save(context("hello"), { body: "Hi\n\nMore", fields: { title: "" } }, { editors: [ben, ana], ifDigest: first.digest, reason: "idle", user: ana })
    expect(result.issues).toEqual([{ field: "title", message: "Add a title.", path: [] }])
    // A draft in progress keeps its fields as written.
    expect(result.stored).toBeUndefined()
    const draft = await posts.get("hello", { ref: "draft" })
    expect(draft).toMatchObject({ body: "Hi\n\nMore", digest: result.digest, issues: [{ field: "title" }] })
    // A valid save stores the default of `tags`; the room merges it.
    const valid = await adapter.save(context("hello"), { body: "Hi\n\nMore", fields: { title: "Fixed" } }, { editors: [ana], ifDigest: result.digest, reason: "idle", user: ana })
    expect(valid).toEqual({ digest: expect.any(String), stored: { body: "Hi\n\nMore", fields: { tags: [], title: "Fixed" } } })
    const [, revision] = (await content.revisions("posts", "hello")).revisions
    expect(revision!.metadata).toMatchObject({ source: "live", author: { id: "ana", name: "Ana" }, editors: [{ id: "ben", name: "Ben" }, { id: "ana", name: "Ana" }] })
    const actions = createContentConsoleActions({ content })
    const listed = await actions.revisions({ collection: "posts", id: "hello" }, { user: ana })
    expect(listed.revisions.map(entry => entry.author)).toEqual(["Ana", "Ben and Ana", undefined])
  })

  it("turns a draft that changed outside the room into a Realtime conflict", async () => {
    const { posts } = await setup()
    const first = await posts.save("hello", { data: { title: "Hello" }, body: "Hi" })
    await posts.save("hello", { data: { title: "Agent" }, body: "Agent wrote this" })
    const error = await rejection(contentDocument(posts).save(context("hello"), { body: "Mine", fields: { title: "Mine" } }, { editors: [], ifDigest: first.digest, reason: "idle" }))
    expect(isRealtimeDocumentConflict(error)).toBe(true)
  })

  it("holds the lease as kind live with the names of the people in the room, and releases it", async () => {
    const { content, posts } = await setup()
    const adapter = contentDocument(posts, { sessions: content.sessions })
    await adapter.hold!(context("hello"), { users: [ana, ben] })
    const [row] = await content.sessions.list("posts")
    expect(row).toMatchObject({ kind: "live", id: "hello", user: { name: "Ana, Ben", image: "https://example.com/ana.png" } })
    await adapter.release!(context("hello"))
    expect(await content.sessions.list("posts")).toEqual([])
  })

  it("fails the hold while a single editor holds the lease", async () => {
    const { content, posts } = await setup()
    await content.sessions.acquire("posts", "hello", { session: "tab-cleo-0001", user: { id: "cleo", name: "Cleo" } })
    await expect(contentDocument(posts, { sessions: content.sessions }).hold!(context("hello"), { users: [ana] }))
      .rejects.toThrow("Cleo is editing this document alone.")
  })

  it("holds nothing without the sessions table", async () => {
    const { content, posts } = await setup({ table: false })
    await expect(contentDocument(posts, { sessions: content.sessions }).hold!(context("hello"), { users: [ana] })).resolves.toBeUndefined()
  })
})

describe("contentRealtime", { timeout: 30_000 }, () => {
  function authorizeContext(documentId: string | null, mode: "read" | "write", user: { id: string, name?: string } | null): RealtimeAuthorizeContext {
    return { definition: "content", documentId, event: undefined, mode, request: new Request("https://example.com"), user }
  }

  it("routes rooms to Markdown documents and singletons only", async () => {
    const { content } = await setup()
    expect(contentLiveTarget(content, "posts/2026/hello")).toMatchObject({ collection: { name: "posts" }, id: "2026/hello" })
    expect(contentLiveTarget(content, "about")).toMatchObject({ collection: { name: "about" }, id: "about" })
    expect(contentLiveTarget(content, "about/about")).toMatchObject({ id: "about" })
    expect(contentLiveTarget(content, "authors/ada")).toBeUndefined()
    expect(contentLiveTarget(content, "posts")).toBeUndefined()
    expect(contentLiveTarget(content, "missing/x")).toBeUndefined()
  })

  it("maps authorize to content.can() and an extra access check", async () => {
    const { content } = await setup()
    const consoleAccess = vi.fn(({ user }: RealtimeAuthorizeContext) => user?.id !== "blocked")
    const definition = contentRealtime(content, { authorize: consoleAccess })
    expect(definition.auth).toBe(true)
    await expect(definition.authorize!(authorizeContext("posts/hello", "write", ana))).resolves.toBe(true)
    await expect(definition.authorize!(authorizeContext("posts/hello", "write", { id: "viewer" }))).resolves.toBe(false)
    await expect(definition.authorize!(authorizeContext("posts/hello", "read", { id: "viewer" }))).resolves.toBe(true)
    await expect(definition.authorize!(authorizeContext("posts/hello", "read", { id: "blocked" }))).resolves.toBe(false)
    await expect(definition.authorize!(authorizeContext("authors/ada", "read", ana))).resolves.toBe(false)
    // The Workspace event channel carries no document; identified people may listen.
    await expect(definition.authorize!(authorizeContext(null, "read", ana))).resolves.toBe(true)
  })

  it("gives content.can() the user that options.user returns", async () => {
    const { content } = await setup()
    const definition = contentRealtime(content, { user: () => ({ id: "ana" }) })
    await expect(definition.authorize!(authorizeContext("posts/hello", "write", { id: "someone-else" }))).resolves.toBe(true)
  })

  it("denies every room with live: false", async () => {
    const { content } = await setup({ live: false })
    expect(content.live).toBe(false)
    await expect(contentRealtime(content).authorize!(authorizeContext("posts/hello", "read", ana))).resolves.toBe(false)
  })

  it("picks the codec of each collection and loads through its document", async () => {
    const { content, posts } = await setup()
    await posts.save("hello", { data: { title: "Hello" }, body: "::alert\nNote\n::\n" })
    const definition = contentRealtime(content)
    const editor = definition.editor
    if (!(editor instanceof Function)) throw new Error("Expected an editor per document.")
    const codec = editor(context("posts/hello"))
    expect(editor(context("posts/other"))).toBe(codec)
    await expect(codec.verify!("::alert\nNote\n::\n", {})).resolves.toMatchObject({ writable: true })
    // The singleton declares no components, so an alert there is lost.
    await expect(editor(context("about")).verify!("::alert\nNote\n::\n", {})).resolves.toMatchObject({ writable: false })
    const document = definition.document as { load: (context: RealtimeDocumentContext) => Promise<unknown> }
    await expect(document.load(context("posts/hello"))).resolves.toMatchObject({ body: "::alert\nNote\n::\n", fields: { title: "Hello" } })
  })
})

describe("writes outside the live room", { timeout: 30_000 }, () => {
  it("refreshes the room of a Markdown document, except for the room's own saves", async () => {
    const { posts, content } = await setup()
    const refresh = vi.fn(async () => true)
    installContentLive({ definition: "content", refresh })
    const saved = await posts.save("2026/hello", { data: { title: "Agent" }, body: "Agent" })
    expect(refresh).toHaveBeenCalledWith("posts/2026/hello")
    refresh.mockClear()
    await posts.save("2026/hello", { data: { title: "Room" }, body: "Room" }, { ifDigest: saved.digest, session: await contentLiveSession("posts", "2026/hello") })
    expect(refresh).not.toHaveBeenCalled()
    await content.collection("authors").save("ada", { data: { name: "Ada" } })
    expect(refresh).not.toHaveBeenCalled()
    await posts.remove("2026/hello")
    expect(refresh).toHaveBeenCalledWith("posts/2026/hello")
  })

  it("keeps saving when the refresh fails, and skips it with live: false", async () => {
    const failing = await setup()
    installContentLive({ definition: "content", refresh: async () => {
      throw new Error("unreachable")
    } })
    await expect(failing.posts.save("hello", { data: { title: "Hello" } })).resolves.toMatchObject({ id: "hello" })
    const off = await setup({ live: false })
    const refresh = vi.fn(async () => true)
    installContentLive({ definition: "content", refresh })
    await off.posts.save("hello", { data: { title: "Hello" } })
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("Console setup", { timeout: 30_000 }, () => {
  it("names the live definition where it is installed, and why it is not elsewhere", async () => {
    const { content } = await setup()
    const actions = createContentConsoleActions({ content })
    expect(await actions.setup!({ user: ana })).toEqual({ live: { unavailable: expect.stringContaining("room authority") } })
    installContentLive({ definition: "content", refresh: async () => false })
    expect(await actions.setup!({ user: ana })).toEqual({ live: { definition: "content" } })
    const off = await setup({ live: false })
    expect(await createContentConsoleActions({ content: off.content }).setup!({ user: ana })).toEqual({})
  })
})
