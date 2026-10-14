import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { readViteHubConsoleActionFailure } from "@vite-hub/internal/console"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { defineContent, documents } from "../src/index.ts"
import { createContentConsoleActions } from "../src/runtime/console.ts"
import { contentConsoleSection } from "../src/vite.ts"

import type { ContentAuthorize } from "../src/index.ts"

const migration = await readFile(new URL("../../workspace/test/fixtures/history.sql", import.meta.url), "utf8")
const sessionsMigration = await readFile(new URL("./fixtures/sessions.sql", import.meta.url), "utf8")
const cleanup: Array<() => Promise<void> | void> = []
let workspaces = 0

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-console-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function historyWorkspace(options: { sessions?: boolean } = {}): Promise<string> {
  const root = await temporaryRoot()
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle(client, { schema: workspaceHistorySchema })
  for (const statement of (options.sessions ? `${migration};${sessionsMigration}` : migration).split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  const name = `console-site-${++workspaces}`
  registerWorkspace(name, { store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: name }) })
  return name
}

// Editors write and publish, writers only write, readers only read drafts. Anyone else gets nothing.
const roles: ContentAuthorize = ({ user, action }) => {
  if (user?.role === "editor") return true
  if (user?.role === "writer") return action !== "publish"
  return user?.role === "reader" && action === "read"
}

async function setup(workspace?: string, title: z.ZodType = z.string().min(1)) {
  const content = defineContent({
    workspace: workspace ?? await historyWorkspace(),
    collections: {
      posts: documents({
        path: "posts/**/*.md",
        fields: { title, date: z.coerce.date(), tags: z.array(z.string()).default([]) },
        components: { alert: { description: "A highlighted note.", props: { type: { type: "string", default: "info" } } }, badge: { kind: "inline" } },
      }),
      notes: documents({ path: "notes/*.md", fields: { body: z.string().optional() } }),
    },
    authorize: roles,
    logger: false,
  })
  cleanup.push(() => content.dispose())
  return { actions: createContentConsoleActions({ content }), content }
}

type Actions = ReturnType<typeof createContentConsoleActions>
type Context = Parameters<Actions["list"]>[1]

/** Publish every change the list shows, as "Publish N changes" does. */
async function publishAll(actions: Actions, context: Context) {
  const { changes } = await actions.list({ collection: "posts" }, context)
  return await actions.publish({ collection: "posts", expect: changes.map(({ id, digest }) => ({ id, digest })) }, context)
}

const editor = { user: { id: "ada", name: "Ada", email: "ada@example.com", role: "editor" } }
const writer = { user: { id: "wes", role: "writer" } }
const reader = { user: { id: "rae", role: "reader" } }
const anonymous = { user: null }
const hello = { collection: "posts", id: "hello", data: { title: "Hello", date: "2026-10-14", tags: ["vue"] }, body: "# Hello\n", ifDigest: null }

async function failure(promise: unknown) {
  try {
    await promise
  }
  catch (error) {
    return readViteHubConsoleActionFailure(error) ?? error
  }
  throw new Error("Expected the action to fail.")
}

describe("Content Console actions", { timeout: 30_000 }, () => {
  it("lists the collections a user may read, with what they may do", async () => {
    const { actions } = await setup()
    const collections = await actions.collections(writer)
    expect(collections.map(collection => collection.name)).toEqual(["posts", "notes"])
    expect(collections[0]).toMatchObject({
      label: "Posts",
      path: "posts/**/*.md",
      titleField: "title",
      access: { read: true, write: true, publish: false },
      schema: { properties: { date: { type: "string", format: "date-time" } } },
    })
    expect(collections[0]!.components).toEqual([
      { name: "alert", kind: "block", label: "Alert", description: "A highlighted note.", props: { type: { type: "string", default: "info" } } },
      { name: "badge", kind: "inline", label: "Badge", props: {} },
    ])
    expect(collections[1]!.components).toBeUndefined()
    expect(await actions.collections(anonymous)).toEqual([])
  })

  it("checks content.can() with the user before each action", async () => {
    const { actions } = await setup()
    await expect(failure(actions.save(hello, reader))).resolves.toMatchObject({ status: 403, code: "CONTENT_FORBIDDEN" })
    await expect(failure(actions.list({ collection: "posts" }, anonymous))).resolves.toMatchObject({ status: 403 })
    const saved = await actions.save(hello, writer)
    expect(saved).toMatchObject({ id: "hello", state: "draft", data: { title: "Hello", date: "2026-10-14T00:00:00.000Z" } })
    await expect(failure(actions.publish({ collection: "posts", expect: [{ id: "hello", digest: saved.digest }] }, writer))).resolves.toMatchObject({ status: 403, code: "CONTENT_FORBIDDEN" })
    await expect(actions.get({ collection: "posts", id: "hello" }, reader)).resolves.toMatchObject({ body: "# Hello\n" })
    await expect(actions.publish({ collection: "posts", expect: [{ id: "hello", digest: saved.digest }] }, editor)).resolves.toMatchObject({ documents: [{ collection: "posts", id: "hello", change: "add" }] })
  })

  it("returns per-field issues for invalid fields", async () => {
    const { actions } = await setup()
    const invalid = await failure(actions.save({ ...hello, data: { title: "", date: "soon" } }, editor))
    expect(invalid).toMatchObject({ status: 422, code: "CONTENT_INVALID", details: { issues: [expect.objectContaining({ field: "title" }), expect.objectContaining({ field: "date" })] } })
  })

  it("returns a conflict when the document changed since it was read", async () => {
    const { actions } = await setup()
    const first = await actions.save(hello, editor)
    const second = await actions.save({ ...hello, body: "Second", ifDigest: first.digest }, editor)
    await expect(failure(actions.save({ ...hello, body: "Lost", ifDigest: first.digest }, editor))).resolves.toMatchObject({
      status: 409,
      code: "WORKSPACE_CONFLICT",
      details: { expected: first.digest, actual: second.digest, ref: "draft" },
    })
    await expect(failure(actions.save({ ...hello, ifDigest: null }, editor))).resolves.toMatchObject({ status: 409 })
    await expect(failure(actions.remove({ collection: "posts", id: "hello", ifDigest: first.digest }, editor))).resolves.toMatchObject({ status: 409 })
  })

  it("lists documents with states, counts, search, filters, and facets", async () => {
    const { actions } = await setup()
    await actions.save(hello, editor)
    await actions.save({ ...hello, id: "launch", data: { title: "Launch", date: "2026-10-01", tags: ["release"] } }, editor)
    await publishAll(actions, editor)
    const launch = await actions.get({ collection: "posts", id: "launch" }, editor)
    await actions.save({ ...hello, id: "launch", data: { title: "Launch v2", date: "2026-10-01" }, ifDigest: launch!.digest }, editor)
    await actions.save({ ...hello, id: "idea", data: { title: "Idea", date: "2026-11-01" } }, editor)
    const removed = await actions.get({ collection: "posts", id: "hello" }, editor)
    await actions.remove({ collection: "posts", id: "hello", ifDigest: removed!.digest }, editor)

    const all = await actions.list({ collection: "posts", facets: ["tags"], sort: { field: "date", direction: "desc" } }, reader)
    expect(all.items.map(item => [item.id, item.title, item.state])).toEqual([["idea", "Idea", "draft"], ["launch", "Launch v2", "changed"]])
    expect(all.items.every(item => String(item.digest) === item.digest && String(item.updatedAt) === item.updatedAt)).toBe(true)
    expect(all.states).toEqual({ draft: 1, published: 0, changed: 1, deleted: 1 })
    // Every unpublished change, with the draft digest that "Publish all" sends back.
    expect(all.changes).toEqual([
      { id: "hello", state: "deleted", digest: null },
      { id: "idea", state: "draft", digest: all.items[0]!.digest },
      { id: "launch", state: "changed", digest: all.items[1]!.digest },
    ])
    expect(all.total).toBe(2)
    expect(all.facets?.tags).toEqual([])

    const deleted = await actions.list({ collection: "posts", state: "deleted" }, reader)
    expect(deleted.items.map(item => [item.id, item.state, item.digest])).toEqual([["hello", "deleted", null]])
    expect((await actions.list({ collection: "posts", state: "published" }, reader)).items).toEqual([])
    expect((await actions.list({ collection: "posts", search: "v2" }, reader)).items.map(item => item.id)).toEqual(["launch"])
    await expect(failure(actions.list({ collection: "posts", limit: 0 }, reader))).resolves.toMatchObject({ status: 400 })
    await expect(failure(actions.list({ collection: "missing" }, reader))).resolves.toMatchObject({ status: 404, code: "CONTENT_COLLECTION_NOT_FOUND" })
  })

  it("records the author and restores an earlier revision", async () => {
    const { actions } = await setup()
    const first = await actions.save(hello, editor)
    await actions.publish({ collection: "posts", expect: [{ id: "hello", digest: first.digest }] }, editor)
    const second = await actions.save({ ...hello, data: { ...hello.data, title: "Hello again" }, ifDigest: first.digest }, writer)
    const history = await actions.revisions({ collection: "posts", id: "hello" }, reader)
    expect(history.revisions.map(revision => [revision.action, revision.ref, revision.author])).toEqual([
      ["save", "draft", "wes"],
      ["publish", "published", "Ada"],
      ["save", "draft", "Ada"],
    ])
    const oldest = history.revisions.at(-1)!
    const stored = await actions.raw({ collection: "posts", id: "hello", revision: oldest.id }, reader)
    expect(stored).toMatchObject({ path: "posts/hello.md", digest: first.digest, revision: oldest.id })
    expect(stored?.text).toContain("title: Hello\n")
    await expect(actions.raw({ collection: "posts", id: "hello" }, reader)).resolves.toMatchObject({ digest: second.digest })
    await expect(actions.raw({ collection: "posts", id: "missing" }, reader)).resolves.toBeNull()
    await expect(failure(actions.raw({ collection: "posts", id: "hello" }, anonymous))).resolves.toMatchObject({ status: 403 })
    await expect(failure(actions.restore({ collection: "posts", id: "hello", revision: oldest.id, ifDigest: first.digest }, editor))).resolves.toMatchObject({ status: 409 })
    const restored = await actions.restore({ collection: "posts", id: "hello", revision: oldest.id, ifDigest: second.digest }, editor)
    expect(restored).toMatchObject({ data: { title: "Hello" }, state: "published" })
  })

  it("publishes only the reviewed drafts and names the documents that moved", async () => {
    const { actions } = await setup()
    const first = await actions.save(hello, editor)
    const reviewed = await actions.list({ collection: "posts" }, editor)
    // Another user saves after the list loaded.
    const newer = await actions.save({ ...hello, body: "Edited after review", ifDigest: first.digest }, writer)
    const conflict = await failure(actions.publish({ collection: "posts", expect: reviewed.changes }, editor))
    expect(conflict).toMatchObject({
      status: 409,
      code: "WORKSPACE_CONFLICT",
      details: { ref: "draft", documents: [{ id: "hello", expected: first.digest, actual: newer.digest }] },
    })
    expect((await actions.list({ collection: "posts" }, editor)).states).toMatchObject({ draft: 1, published: 0 })
    await expect(publishAll(actions, editor)).resolves.toMatchObject({ documents: [{ id: "hello", change: "add" }] })
    await expect(failure(actions.publish({ collection: "posts", expect: [] }, editor))).resolves.toMatchObject({ status: 400 })
    await expect(failure(actions.publish({ collection: "posts" } as never, editor))).resolves.toMatchObject({ status: 400 })
  })

  it("names the draft that no longer validates when publishing", async () => {
    const workspace = await historyWorkspace()
    const before = await setup(workspace)
    await before.actions.save(hello, editor)
    // The definition changed after the draft was saved.
    const after = await setup(workspace, z.string().min(10))
    const { changes } = await after.actions.list({ collection: "posts" }, editor)
    await expect(failure(after.actions.publish({ collection: "posts", expect: changes }, editor))).resolves.toMatchObject({
      status: 422,
      code: "CONTENT_INVALID",
      details: { id: "hello", issues: [expect.objectContaining({ field: "title" })] },
    })
  })

  it("summarizes the collections a user may read for the dashboard", async () => {
    const workspace = await historyWorkspace()
    const { actions } = await setup(workspace)
    await actions.save(hello, editor)
    await actions.save({ ...hello, id: "launch", data: { title: "Launch", date: "2026-10-01" } }, writer)
    await publishAll(actions, editor)
    const launch = await actions.get({ collection: "posts", id: "launch" }, editor)
    await actions.save({ ...hello, id: "launch", data: { title: "Launch v2", date: "2026-10-01" }, ifDigest: launch!.digest }, writer)
    await actions.save({ collection: "notes", id: "todo", data: {}, body: "Remember the milk", ifDigest: null }, writer)
    const removed = await actions.get({ collection: "posts", id: "hello" }, editor)
    await actions.remove({ collection: "posts", id: "hello", ifDigest: removed!.digest }, editor)

    const overview = await actions.overview({}, reader)
    expect(overview.collections).toEqual([
      {
        name: "posts",
        states: { draft: 0, published: 0, changed: 1, deleted: 1 },
        // Most recently changed first. A deleted document keeps its published title.
        changes: [
          { id: "launch", state: "changed", digest: expect.any(String), title: "Launch v2", updatedAt: expect.any(String) },
          { id: "hello", state: "deleted", digest: null, title: "Hello", updatedAt: null },
        ],
        scheduled: [],
      },
      {
        name: "notes",
        states: { draft: 1, published: 0, changed: 0, deleted: 0 },
        changes: [{ id: "todo", state: "draft", digest: expect.any(String), title: "todo", updatedAt: expect.any(String) }],
        scheduled: [],
      },
    ])
    expect(overview.activity[0]).toMatchObject({ action: "remove", ref: "draft", author: "Ada", documents: [{ collection: "posts", id: "hello", title: "Hello" }] })
    expect(overview.activity.find(entry => entry.action === "publish")).toMatchObject({
      ref: "published",
      documents: expect.arrayContaining([{ collection: "posts", id: "hello", title: "Hello" }, { collection: "posts", id: "launch", title: "Launch v2" }]),
    })
    expect(overview.activity).toHaveLength(6)
    expect((await actions.overview({ activity: 2 }, reader)).activity).toHaveLength(2)
    expect((await actions.overview({ activity: 0 }, reader)).activity).toEqual([])
    await expect(actions.overview({}, anonymous)).resolves.toEqual({ collections: [], activity: [] })
    await expect(failure(actions.overview({ activity: 51 }, reader))).resolves.toMatchObject({ status: 400 })

    // Collections the user may not read stay out of the counts and the activity.
    const postsOnly = defineContent({
      workspace,
      collections: {
        posts: documents({ path: "posts/**/*.md", fields: { title: z.string().min(1), date: z.coerce.date(), tags: z.array(z.string()).default([]) } }),
        notes: documents({ path: "notes/*.md", fields: { body: z.string().optional() } }),
      },
      authorize: ({ collection, action }) => collection === "posts" && action === "read",
      logger: false,
    })
    cleanup.push(() => postsOnly.dispose())
    const scoped = await createContentConsoleActions({ content: postsOnly }).overview({}, reader)
    expect(scoped.collections.map(collection => collection.name)).toEqual(["posts"])
    expect(scoped.activity.flatMap(entry => entry.documents.map(document => document.collection))).not.toContain("notes")
  })

  it("searches drafts across readable collections by title, id, fields, and body", async () => {
    const { actions } = await setup()
    await actions.save(hello, editor)
    await actions.save({ ...hello, id: "2026/spring", data: { title: "Spring update", date: "2026-03-01" }, body: "Ship it\n" }, editor)
    // The notes collection names a field `body`, so its search matches that field.
    await actions.save({ collection: "notes", id: "todo", data: { body: "Say hello to the team" }, body: "", ifDigest: null }, editor)
    await actions.save({ ...hello, id: "release", data: { title: "Release", date: "2026-04-01" }, body: "Hello from the release\n" }, editor)
    await publishAll(actions, editor)
    await actions.save({ ...hello, id: "draft-hello", data: { title: "Say Hello", date: "2026-10-02" } }, editor)

    const results = await actions.search({ query: "hello" }, reader)
    // Titles that start with the text lead, then titles that contain it, then other matches such as the body.
    expect(results.items.map(item => [item.collection, item.id, item.title, item.state])).toEqual([
      ["posts", "hello", "Hello", "published"],
      ["posts", "draft-hello", "Say Hello", "draft"],
      ["posts", "release", "Release", "published"],
      ["notes", "todo", "todo", "draft"],
    ])
    expect((await actions.search({ query: "2026/" }, reader)).items.map(item => item.id)).toEqual(["2026/spring"])
    expect((await actions.search({ query: "ship" }, reader)).items.map(item => item.id)).toEqual(["2026/spring"])
    expect((await actions.search({ query: "hello", limit: 1 }, reader)).items).toHaveLength(1)
    await expect(actions.search({ query: "hello" }, anonymous)).resolves.toEqual({ items: [] })
    await expect(failure(actions.search({ query: " " }, reader))).resolves.toMatchObject({ status: 400 })
    await expect(failure(actions.search({ query: "a", limit: 51 }, reader))).resolves.toMatchObject({ status: 400 })
  })

  it("hides documents a per-document policy denies from the list, dashboard, and search", async () => {
    const workspace = await historyWorkspace()
    const { actions: editorActions } = await setup(workspace)
    await editorActions.save(hello, editor)
    await editorActions.save({ ...hello, id: "secret", data: { title: "Hello secret", date: "2026-10-03" } }, editor)
    // A published document that is now deleted on the draft still has a title and activity.
    await editorActions.save({ ...hello, id: "gone", data: { title: "Hello gone", date: "2026-10-04" } }, editor)
    await publishAll(editorActions, editor)
    const gone = await editorActions.get({ collection: "posts", id: "gone" }, editor)
    await editorActions.remove({ collection: "posts", id: "gone", ifDigest: gone!.digest }, editor)

    const hidden = new Set(["secret", "gone"])
    const scoped = defineContent({
      workspace,
      collections: {
        posts: documents({ path: "posts/**/*.md", fields: { title: z.string().min(1), date: z.coerce.date(), tags: z.array(z.string()).default([]) } }),
      },
      authorize: ({ action, id }) => action === "read" && !(id !== undefined && hidden.has(id)),
      logger: false,
    })
    cleanup.push(() => scoped.dispose())
    const actions = createContentConsoleActions({ content: scoped })

    const listed = await actions.list({ collection: "posts" }, reader)
    expect(listed.items.map(item => item.id)).toEqual(["hello"])
    expect(listed.states).toEqual({ draft: 0, published: 1, changed: 0, deleted: 0 })

    const overview = await actions.overview({}, reader)
    expect(overview.collections).toEqual([{ name: "posts", states: { draft: 0, published: 1, changed: 0, deleted: 0 }, changes: [], scheduled: [] }])
    const named = overview.activity.flatMap(entry => entry.documents)
    expect(named.length).toBeGreaterThan(0)
    expect(named.map(document => document.id)).toEqual(named.map(() => "hello"))
    expect(JSON.stringify(overview)).not.toMatch(/secret|gone/i)

    expect((await actions.search({ query: "hello" }, reader)).items.map(item => item.id)).toEqual(["hello"])
    expect((await actions.search({ query: "secret" }, reader)).items).toEqual([])
  })

  it("rejects malformed input without calling the runtime", async () => {
    const { actions } = await setup()
    await expect(failure(actions.save({ ...hello, ifDigest: undefined } as never, editor))).resolves.toMatchObject({ status: 400 })
    await expect(failure(actions.save({ ...hello, body: 1 } as never, editor))).resolves.toMatchObject({ status: 400 })
    await expect(failure(actions.save({ ...hello, id: "../escape" }, editor))).resolves.toMatchObject({ status: 400, code: "CONTENT_R0008" })
    await expect(failure(actions.get(null as never, editor))).resolves.toMatchObject({ status: 400 })
  })

  it("finds the draft and published documents that use Blob pathnames", async () => {
    const content = defineContent({
      workspace: await historyWorkspace(),
      collections: {
        posts: documents({
          path: "posts/*.md",
          fields: { title: z.string(), cover: z.object({ pathname: z.string(), contentType: z.string().optional() }).optional(), gallery: z.array(z.string()).default([]) },
        }),
        notes: documents({ path: "notes/*.md", fields: { title: z.string() } }),
      },
      authorize: ({ user, collection }) => user?.role === "editor" || (user?.role === "writer" && collection === "posts"),
      logger: false,
    })
    cleanup.push(() => content.dispose())
    const actions = createContentConsoleActions({ content })
    const cover = { pathname: "heroes/launch.jpg", contentType: "image/jpeg" }
    const launch = await actions.save({ collection: "posts", id: "launch", data: { title: "Launch", cover }, body: "Text\n", ifDigest: null }, editor)
    await actions.publish({ collection: "posts", expect: [{ id: "launch", digest: launch.digest }] }, editor)
    // The draft drops the cover; the published version still uses it.
    await actions.save({ collection: "posts", id: "launch", data: { title: "Launch" }, body: "Text\n", ifDigest: launch.digest }, editor)
    await actions.save({ collection: "posts", id: "gallery", data: { title: "Gallery", gallery: ["heroes/launch.jpg"] }, body: "", ifDigest: null }, editor)
    await actions.save({ collection: "notes", id: "body", data: { title: "In the body" }, body: "![Launch](heroes/launch.jpg)\n", ifDigest: null }, editor)
    const found = await actions.references({ pathnames: ["heroes/launch.jpg", "unused.png"] }, editor)
    expect(found.references["unused.png"]).toEqual([])
    expect(found.references["heroes/launch.jpg"]).toEqual(expect.arrayContaining([
      { collection: "posts", id: "launch", title: "Launch", refs: ["published"] },
      { collection: "posts", id: "gallery", title: "Gallery", refs: ["draft"] },
      { collection: "notes", id: "body", title: "In the body", refs: ["draft"] },
    ]))
    expect(found.references["heroes/launch.jpg"]).toHaveLength(3)
    // Only collections the user may read.
    const scoped = await actions.references({ pathnames: ["heroes/launch.jpg"] }, writer)
    expect(scoped.references["heroes/launch.jpg"]!.map(reference => reference.collection)).toEqual(["posts", "posts"])
    await expect(failure(actions.references({ pathnames: Array.from({ length: 101 }, (_, index) => `${index}.png`) }, editor))).resolves.toMatchObject({ status: 400 })
  })

  it("hides documents a per-document policy denies from the media references", async () => {
    const workspace = await historyWorkspace()
    const cover = { pathname: "heroes/launch.jpg" }
    const fields = { title: z.string(), cover: z.object({ pathname: z.string() }).optional() }
    // Readers may read every document but `secret`, which uses the file in a field, and `aside`, which uses it in the body.
    const hidden = new Set(["secret", "aside"])
    const content = defineContent({
      workspace,
      collections: { posts: documents({ path: "posts/*.md", fields }) },
      authorize: ({ user, action, id }) => user?.role === "editor" || (user?.role === "reader" && action === "read" && !(id !== undefined && hidden.has(id))),
      logger: false,
    })
    cleanup.push(() => content.dispose())
    const actions = createContentConsoleActions({ content })
    await actions.save({ collection: "posts", id: "launch", data: { title: "Launch", cover }, body: "", ifDigest: null }, editor)
    await actions.save({ collection: "posts", id: "secret", data: { title: "Secret plan", cover }, body: "", ifDigest: null }, editor)
    await actions.save({ collection: "posts", id: "aside", data: { title: "Hidden aside" }, body: "![Launch](heroes/launch.jpg)\n", ifDigest: null }, editor)
    await publishAll(actions, editor)

    const all = await actions.references({ pathnames: ["heroes/launch.jpg"] }, editor)
    expect(all.references["heroes/launch.jpg"]!.map(reference => reference.id).sort()).toEqual(["aside", "launch", "secret"])
    const found = await actions.references({ pathnames: ["heroes/launch.jpg"] }, reader)
    expect(found.references["heroes/launch.jpg"]).toEqual([{ collection: "posts", id: "launch", title: "Launch", refs: ["draft", "published"] }])
    expect(JSON.stringify(found)).not.toMatch(/secret|aside/i)
  })

  it("gives media access from the widest collection access", async () => {
    const { actions } = await setup()
    await expect(actions.mediaAccess(editor)).resolves.toEqual({ read: true, write: true, manage: true })
    await expect(actions.mediaAccess(writer)).resolves.toEqual({ read: true, write: true, manage: false })
    await expect(actions.mediaAccess(reader)).resolves.toEqual({ read: true, write: false, manage: false })
    await expect(actions.mediaAccess(anonymous)).resolves.toEqual({ read: false, write: false, manage: false })
  })

  it("requires the defineContent() runtime as `content`", () => {
    expect(() => createContentConsoleActions({})).toThrow("must export the defineContent() runtime as `content`")
    expect(() => createContentConsoleActions({ content: { collection: () => undefined } })).toThrow(TypeError)
  })
})

describe("Content Console sessions", { timeout: 30_000 }, () => {
  const tabA = "console-tab-0001"
  const tabB = "console-tab-0002"

  it("reports presence with the Console user and marks this tab", async () => {
    const { actions } = await setup(await historyWorkspace({ sessions: true }))
    const viewing = await actions.session({ collection: "posts", id: "hello", session: tabA, action: "report", kind: "view" }, editor)
    expect(viewing).toMatchObject({
      user: { id: "ada", name: "Ada" },
      available: true,
      editing: false,
      lease: true,
      holder: null,
      sessions: [{ collection: "posts", id: "hello", user: { id: "ada", name: "Ada" }, kind: "view", since: null, self: true }],
    })
    // A user without a name shows as their id; another tab never sees this tab's token.
    const other = await actions.session({ collection: "posts", id: "hello", session: tabB, action: "report", kind: "view" }, writer)
    expect(other.sessions.map(entry => [entry.user.name, entry.self])).toEqual(expect.arrayContaining([["Ada", false], ["wes", true]]))
    expect(JSON.stringify(other)).not.toContain(tabA)
  })

  it("takes the lease on first edit, blocks other tabs, and hands it over", async () => {
    const { actions } = await setup(await historyWorkspace({ sessions: true }))
    const created = await actions.save({ ...hello, session: tabA }, editor)
    expect((await actions.session({ collection: "posts", id: "hello", session: tabA, action: "acquire" }, editor)).editing).toBe(true)
    const blocked = await actions.session({ collection: "posts", id: "hello", session: tabB, action: "acquire" }, writer)
    expect(blocked).toMatchObject({ editing: false, holder: { user: { name: "Ada" }, kind: "edit", self: false } })
    expect(blocked.holder!.since).toEqual(expect.any(String))
    expect(await failure(actions.save({ ...hello, ifDigest: created.digest, session: tabB }, writer))).toMatchObject({
      status: 409,
      code: "CONTENT_LEASE_HELD",
      message: "Ada is editing this document.",
      details: { holder: { user: { id: "ada", name: "Ada" }, since: blocked.holder!.since } },
    })
    const saved = await actions.save({ ...hello, data: { ...hello.data, title: "By Ada" }, ifDigest: created.digest, session: tabA }, editor)
    const taken = await actions.session({ collection: "posts", id: "hello", session: tabB, action: "takeover" }, writer)
    expect(taken).toMatchObject({ editing: true, holder: { user: { id: "wes" }, self: true } })
    const former = await actions.session({ collection: "posts", id: "hello", session: tabA, action: "report", kind: "edit", input: true }, editor)
    expect(former).toMatchObject({ editing: false, holder: { user: { id: "wes" } } })
    expect(await failure(actions.save({ ...hello, ifDigest: saved.digest, session: tabA }, editor))).toMatchObject({ status: 409, code: "CONTENT_LEASE_HELD" })
    await actions.session({ collection: "posts", id: "hello", session: tabB, action: "release" }, writer)
    await expect(actions.save({ ...hello, ifDigest: saved.digest, session: tabA }, editor)).resolves.toMatchObject({ id: "hello" })
  })

  it("needs write access to take the lease and read access to report", async () => {
    const { actions } = await setup(await historyWorkspace({ sessions: true }))
    await expect(actions.session({ collection: "posts", id: "hello", session: tabA, action: "report", kind: "view" }, reader)).resolves.toMatchObject({ editing: false })
    expect(await failure(actions.session({ collection: "posts", id: "hello", session: tabA, action: "acquire" }, reader))).toMatchObject({ status: 403 })
    expect(await failure(actions.session({ collection: "posts", id: "hello", session: tabA, action: "takeover" }, reader))).toMatchObject({ status: 403 })
    expect(await failure(actions.session({ collection: "posts", id: "hello", session: tabA, action: "report" }, anonymous))).toMatchObject({ status: 403 })
    expect(await failure(actions.session({ collection: "posts", id: "hello", session: tabA, action: "steal" as never }, editor))).toMatchObject({ status: 400 })
  })

  it("lists open tabs across readable collections for list rows and the dashboard", async () => {
    const { actions } = await setup(await historyWorkspace({ sessions: true }))
    await actions.session({ collection: "posts", id: "hello", session: tabA, action: "acquire" }, editor)
    await actions.session({ collection: "notes", id: "today", session: tabB, action: "report", kind: "view" }, writer)
    const all = await actions.sessions({ session: tabA }, editor)
    expect(all).toMatchObject({ user: { id: "ada" }, available: true })
    expect(all.sessions.map(entry => `${entry.collection}/${entry.id}:${entry.user.name}:${entry.kind}:${entry.self}`)).toEqual(["notes/today:wes:view:false", "posts/hello:Ada:edit:true"])
    expect((await actions.sessions({ collection: "posts" }, reader)).sessions.map(entry => entry.id)).toEqual(["hello"])
    expect(await failure(actions.sessions({ collection: "posts" }, anonymous))).toMatchObject({ status: 403 })
  })

  it("stays editable when the Database has no sessions table", async () => {
    const { actions } = await setup()
    const presence = await actions.session({ collection: "posts", id: "hello", session: tabA, action: "acquire" }, editor)
    expect(presence).toMatchObject({ available: false, editing: true, holder: null, sessions: [] })
    expect(presence.reason).toContain("contentSessionsSchema")
    await expect(actions.sessions({}, editor)).resolves.toMatchObject({ available: false, sessions: [] })
    await expect(actions.save({ ...hello, session: tabA }, editor)).resolves.toMatchObject({ id: "hello" })
  })
})

describe("Content Console section", () => {
  async function entryFor(source: string): Promise<boolean> {
    const root = await temporaryRoot()
    await mkdir(join(root, "server"))
    await writeFile(join(root, "server/content.ts"), source)
    const entry = await contentConsoleSection.entry({ projectRoot: root })
    if (entry !== undefined) expect(entry).toBe(join(root, "server/content.ts"))
    return entry !== undefined
  }

  it("shows the section only when server/content.ts defines document collections", async () => {
    await expect(contentConsoleSection.entry({ projectRoot: await temporaryRoot() })).resolves.toBeUndefined()
    const imports = `import { defineContent, documents } from "vite-hub/content"\n`
    await expect(entryFor(`${imports}export const content = defineContent({ workspace: "site", collections: { posts: documents({ path: "posts/*.md", fields: {} }) } })\n`)).resolves.toBe(true)
    // Read-only Sources, or no collections, leave nothing to edit.
    await expect(entryFor(`${imports}export const content = defineContent({ source: "content" })\n`)).resolves.toBe(false)
    await expect(entryFor(`${imports}export const content = defineContent()\n`)).resolves.toBe(false)
    await expect(entryFor(`${imports}export const content = defineContent({ workspace: "site", collections: {} })\n`)).resolves.toBe(false)
    await expect(entryFor(`import { defineContent as define } from "@vite-hub/content"\nconst options = { sources: {} }\nconst content = define(options)\nexport { content }\n`)).resolves.toBe(false)
    // Collections that discovery cannot follow keep the section; the editor lists what the runtime has.
    await expect(entryFor(`${imports}const collections = { posts: documents({ path: "posts/*.md", fields: {} }) }\nexport const content = defineContent({ workspace: "site", collections } satisfies object)\n`)).resolves.toBe(true)
    await expect(entryFor(`${imports}import { collections } from "./collections"\nexport const content = defineContent({ workspace: "site", collections })\n`)).resolves.toBe(true)
    await expect(entryFor(`${imports}import { options } from "./options"\nexport const content = defineContent({ ...options })\n`)).resolves.toBe(true)
    await expect(entryFor(`import { createContent } from "./create"\nexport const content = createContent()\n`)).resolves.toBe(true)
    expect(contentConsoleSection).toMatchObject({ id: "content", view: { kind: "document-editor" }, actions: { module: "@vite-hub/content/runtime/console", export: "createContentConsoleActions" } })
    // The dashboard opens at /_vitehub/content; Media shows only when the project enables Blob.
    expect(contentConsoleSection.pages).toEqual([
      { id: "dashboard", label: "Dashboard", icon: "i-lucide-layout-dashboard", index: true, view: { kind: "document-dashboard" } },
      { id: "settings", label: "Settings", icon: "i-lucide-settings-2", group: "Site", view: { kind: "document-settings" } },
      { id: "media", label: "Media", icon: "i-lucide-image", group: "Assets", requires: ["blob"], view: { kind: "media-library" } },
    ])
  })
})
