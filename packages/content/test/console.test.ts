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

async function historyWorkspace(): Promise<string> {
  const root = await temporaryRoot()
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle(client, { schema: workspaceHistorySchema })
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
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

async function setup() {
  const content = defineContent({
    workspace: await historyWorkspace(),
    collections: {
      posts: documents({ path: "posts/**/*.md", fields: { title: z.string().min(1), date: z.coerce.date(), tags: z.array(z.string()).default([]) } }),
      notes: documents({ path: "notes/*.md", fields: { body: z.string().optional() } }),
    },
    authorize: roles,
    logger: false,
  })
  cleanup.push(() => content.dispose())
  return { actions: createContentConsoleActions({ content }), content }
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
    expect(await actions.collections(anonymous)).toEqual([])
  })

  it("checks content.can() with the user before each action", async () => {
    const { actions } = await setup()
    await expect(failure(actions.save(hello, reader))).resolves.toMatchObject({ status: 403, code: "CONTENT_FORBIDDEN" })
    await expect(failure(actions.list({ collection: "posts" }, anonymous))).resolves.toMatchObject({ status: 403 })
    const saved = await actions.save(hello, writer)
    expect(saved).toMatchObject({ id: "hello", state: "draft", data: { title: "Hello", date: "2026-10-14T00:00:00.000Z" } })
    await expect(failure(actions.publish({ collection: "posts" }, writer))).resolves.toMatchObject({ status: 403, code: "CONTENT_FORBIDDEN" })
    await expect(failure(actions.publish({ collection: "posts", ids: ["hello"] }, writer))).resolves.toMatchObject({ status: 403 })
    await expect(actions.get({ collection: "posts", id: "hello" }, reader)).resolves.toMatchObject({ body: "# Hello\n" })
    await expect(actions.publish({ collection: "posts", ids: ["hello"] }, editor)).resolves.toMatchObject({ documents: [{ collection: "posts", id: "hello", change: "add" }] })
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
    await actions.publish({ collection: "posts" }, editor)
    const launch = await actions.get({ collection: "posts", id: "launch" }, editor)
    await actions.save({ ...hello, id: "launch", data: { title: "Launch v2", date: "2026-10-01" }, ifDigest: launch!.digest }, editor)
    await actions.save({ ...hello, id: "idea", data: { title: "Idea", date: "2026-11-01" } }, editor)
    const removed = await actions.get({ collection: "posts", id: "hello" }, editor)
    await actions.remove({ collection: "posts", id: "hello", ifDigest: removed!.digest }, editor)

    const all = await actions.list({ collection: "posts", facets: ["tags"], sort: { field: "date", direction: "desc" } }, reader)
    expect(all.items.map(item => [item.id, item.title, item.state])).toEqual([["idea", "Idea", "draft"], ["launch", "Launch v2", "changed"]])
    expect(all.states).toEqual({ draft: 1, published: 0, changed: 1, deleted: 1 })
    expect(all.total).toBe(2)
    expect(all.facets?.tags).toEqual([])

    const deleted = await actions.list({ collection: "posts", state: "deleted" }, reader)
    expect(deleted.items.map(item => [item.id, item.state])).toEqual([["hello", "deleted"]])
    expect((await actions.list({ collection: "posts", state: "published" }, reader)).items).toEqual([])
    expect((await actions.list({ collection: "posts", search: "v2" }, reader)).items.map(item => item.id)).toEqual(["launch"])
    await expect(failure(actions.list({ collection: "posts", limit: 0 }, reader))).resolves.toMatchObject({ status: 400 })
    await expect(failure(actions.list({ collection: "missing" }, reader))).resolves.toMatchObject({ status: 404, code: "CONTENT_COLLECTION_NOT_FOUND" })
  })

  it("records the author and restores an earlier revision", async () => {
    const { actions } = await setup()
    const first = await actions.save(hello, editor)
    await actions.publish({ collection: "posts", ids: ["hello"] }, editor)
    const second = await actions.save({ ...hello, data: { ...hello.data, title: "Hello again" }, ifDigest: first.digest }, writer)
    const history = await actions.revisions({ collection: "posts", id: "hello" }, reader)
    expect(history.revisions.map(revision => [revision.action, revision.ref, revision.author])).toEqual([
      ["save", "draft", "wes"],
      ["publish", "published", "Ada"],
      ["save", "draft", "Ada"],
    ])
    const oldest = history.revisions.at(-1)!
    await expect(actions.get({ collection: "posts", id: "hello", revision: oldest.id }, reader)).resolves.toMatchObject({ data: { title: "Hello" } })
    await expect(failure(actions.restore({ collection: "posts", id: "hello", revision: oldest.id, ifDigest: first.digest }, editor))).resolves.toMatchObject({ status: 409 })
    const restored = await actions.restore({ collection: "posts", id: "hello", revision: oldest.id, ifDigest: second.digest }, editor)
    expect(restored).toMatchObject({ data: { title: "Hello" }, state: "published" })
  })

  it("rejects malformed input without calling the runtime", async () => {
    const { actions } = await setup()
    await expect(failure(actions.save({ ...hello, ifDigest: undefined } as never, editor))).resolves.toMatchObject({ status: 400 })
    await expect(failure(actions.save({ ...hello, body: 1 } as never, editor))).resolves.toMatchObject({ status: 400 })
    await expect(failure(actions.save({ ...hello, id: "../escape" }, editor))).resolves.toMatchObject({ status: 400, code: "CONTENT_R0008" })
    await expect(failure(actions.get(null as never, editor))).resolves.toMatchObject({ status: 400 })
  })

  it("requires the defineContent() runtime as `content`", () => {
    expect(() => createContentConsoleActions({})).toThrow("must export the defineContent() runtime as `content`")
    expect(() => createContentConsoleActions({ content: { collection: () => undefined } })).toThrow(TypeError)
  })
})

describe("Content Console section", () => {
  it("finds server/content.ts for the Console", async () => {
    const root = await temporaryRoot()
    await expect(contentConsoleSection.entry({ projectRoot: root })).resolves.toBeUndefined()
    await mkdir(join(root, "server"))
    await writeFile(join(root, "server/content.ts"), "export const content = {}\n")
    await expect(contentConsoleSection.entry({ projectRoot: root })).resolves.toBe(join(root, "server/content.ts"))
    expect(contentConsoleSection).toMatchObject({ id: "content", view: { kind: "document-editor" }, actions: { module: "@vite-hub/content/runtime/console", export: "createContentConsoleActions" } })
  })
})
