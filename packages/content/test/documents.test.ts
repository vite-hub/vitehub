import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { H3 } from "h3"
import { toStandardJsonSchema } from "@valibot/to-json-schema"
import * as v from "valibot"
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import { z } from "zod"

import { isWorkspaceConflict, useWorkspace } from "@vite-hub/workspace"
import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"
import { defineCollectionHandler } from "@vite-hub/source/server"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { defineContent, documents, optional } from "../src/index.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { ContentAuthorize, ContentDocument } from "../src/index.ts"

const migration = await readFile(new URL("../../workspace/test/fixtures/history.sql", import.meta.url), "utf8")
const cleanup: Array<() => Promise<void> | void> = []
let workspaces = 0

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

/** A Workspace on the Blob + Database Store, as the Workspace history tests use. */
async function historyWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle(client, { schema: workspaceHistorySchema })
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  const name = `site-${++workspaces}`
  registerWorkspace(name, { store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: name }) })
  return name
}

/** A second Store instance over the same Database and Blob, like another server process. */
const fields = {
  title: z.string().min(1),
  date: z.coerce.date(),
  tags: z.array(z.string()).default([]),
  summary: optional(v.string()),
}

async function setup(options: { authorize?: ContentAuthorize } = {}) {
  const workspace = await historyWorkspace()
  const content = defineContent({
    workspace,
    collections: {
      posts: documents({ path: "posts/**/*.md", fields }),
    },
    authorize: options.authorize,
    logger: false,
  })
  cleanup.push(() => content.dispose())
  return { content, posts: content.collection("posts"), workspace }
}

const hello = { data: { title: "Hello", date: "2026-10-14", tags: ["vue"] }, body: "# Hello\n\nFirst post.\n" }

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
  }
  catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject.")
}

describe("document collections", { timeout: 30_000 }, () => {
  it("saves validated documents to the draft ref and reads them back", async () => {
    const { posts } = await setup()
    const saved = await posts.save("hello", hello, { ifDigest: null })
    expect(saved).toMatchObject({
      collection: "posts",
      id: "hello",
      path: "posts/hello.md",
      body: hello.body,
      data: { title: "Hello", date: new Date("2026-10-14"), tags: ["vue"] },
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(await posts.get("hello")).toBeNull()
    expect(await posts.get("hello", { ref: "draft" })).toEqual(saved)
    expect(await posts.status("hello")).toEqual({ collection: "posts", id: "hello", state: "draft", draft: saved.digest, published: null })
  })

  it("reports every invalid field with a readable CONTENT_INVALID error", async () => {
    const { posts } = await setup()
    // @ts-expect-error title must be a string
    const error = await rejection(posts.save("bad", { data: { title: 1, date: "not a date" } }))
    expect(error).toMatchObject({
      code: "CONTENT_INVALID",
      details: { collection: "posts", id: "bad", path: "posts/bad.md", issues: [expect.objectContaining({ field: "title" }), expect.objectContaining({ field: "date" })] },
    })
    expect(error.message).toContain("- title:")
    expect(error.message).toContain("- date:")
    expect(await posts.status("bad")).toBeNull()
  })

  it("validates every Workspace writer through the plugin hook", async () => {
    const { posts, workspace } = await setup()
    const facade = useWorkspace(workspace as never, { mode: "write" })
    await expect(facade.fs.writeFile("posts/agent.md" as never, "---\ntitle: 3\n---\nBody")).rejects.toMatchObject({ code: "CONTENT_INVALID" })
    await expect(facade.history.commit({ ref: "draft", ifHead: null, changes: { put: { "posts/raw.md": "---\ndate: nope\n---\n" } } }))
      .rejects.toMatchObject({ code: "CONTENT_INVALID", details: { id: "raw" } })
    // Paths outside the collection and valid documents pass.
    await facade.fs.writeFile("notes/free.md" as never, "anything")
    await facade.history.commit({ ref: "draft", ifHead: null, changes: { put: { "posts/raw.md": "---\ntitle: Raw\ndate: 2026-01-01\n---\nBody" } } })
    expect(await posts.get("raw", { ref: "draft" })).toMatchObject({ data: { title: "Raw", tags: [] }, body: "Body" })
  })

  it("rejects stale and duplicate ifDigest values with WORKSPACE_CONFLICT", async () => {
    const { posts } = await setup()
    const first = await posts.save("hello", hello, { ifDigest: null })
    const duplicate = await rejection(posts.save("hello", hello, { ifDigest: null }))
    expect(isWorkspaceConflict(duplicate)).toBe(true)
    expect(duplicate.details).toMatchObject({ collection: "posts", id: "hello", ref: "draft", expected: null, actual: first.digest })
    const second = await posts.save("hello", { ...hello, body: "Edited" }, { ifDigest: first.digest })
    const stale = await rejection(posts.save("hello", { ...hello, body: "Lost" }, { ifDigest: first.digest }))
    expect(stale).toMatchObject({ code: "WORKSPACE_CONFLICT", details: { expected: first.digest, actual: second.digest } })
    await expect(posts.remove("hello", { ifDigest: first.digest })).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
    expect((await posts.get("hello", { ref: "draft" }))?.body).toBe("Edited")
  })

  it("retries when another document moved the draft head", async () => {
    const { posts } = await setup()
    await posts.save("seed", hello)
    const saved = await Promise.all(["a", "b", "c", "d"].map(id => posts.save(id, { ...hello, data: { ...hello.data, title: id } }, { ifDigest: null })))
    expect(saved.map(document => document.data.title)).toEqual(["a", "b", "c", "d"])
    expect((await posts.status()).map(entry => entry.id)).toEqual(["a", "b", "c", "d", "seed"])
  })

  it("starts an empty draft from published content on the first save", async () => {
    const { posts, workspace } = await setup()
    const facade = useWorkspace(workspace as never, { mode: "write" })
    await facade.history.commit({ ref: "published", ifHead: null, files: { "posts/old.md": "---\ntitle: Old\ndate: 2026-01-01\n---\n", "readme.md": "Site" } })
    expect(await posts.status("old")).toMatchObject({ state: "published" })
    await posts.save("new", hello)
    expect(await posts.status()).toEqual([expect.objectContaining({ id: "new", state: "draft" }), expect.objectContaining({ id: "old", state: "published" })])
    expect(await (await facade.history.open((await facade.history.head({ ref: "draft" }))!.id)).readFile("readme.md")).toBe("Site")
  })

  it("keeps the draft revision when the saved content is unchanged", async () => {
    const { posts } = await setup()
    const first = await posts.save("hello", hello)
    const again = await posts.save("hello", hello, { ifDigest: first.digest })
    expect(again.revision).toBe(first.revision)
  })

  it("publishes selected documents, deletions, and reports status", async () => {
    const { content, posts } = await setup()
    await posts.save("hello", hello)
    await posts.save("second", { ...hello, data: { ...hello.data, title: "Second" } })
    const first = await content.publish({ collection: "posts", ids: ["hello"], message: "Ship hello", metadata: { author: "maxi" } })
    expect(first.documents).toEqual([{ collection: "posts", id: "hello", change: "add" }])
    expect(first.revision).toMatchObject({ ref: "published", message: "Ship hello", metadata: { author: "maxi", content: { action: "publish" } } })
    expect(await posts.get("hello")).toMatchObject({ data: { title: "Hello" } })
    expect(await posts.get("second")).toBeNull()
    expect(await posts.status()).toEqual([
      expect.objectContaining({ id: "hello", state: "published" }),
      expect.objectContaining({ id: "second", state: "draft" }),
    ])

    await posts.save("hello", { ...hello, data: { ...hello.data, title: "Hello again" } })
    expect(await posts.status("hello")).toMatchObject({ state: "changed" })
    await posts.remove("second")
    expect(await posts.status("second")).toBeNull()

    await content.publish({ collection: "posts", ids: ["hello"] })
    await posts.remove("hello")
    expect(await posts.status("hello")).toMatchObject({ state: "deleted", draft: null })
    expect(await posts.get("hello")).toMatchObject({ data: { title: "Hello again" } })
    const deletion = await content.publish()
    expect(deletion.documents).toEqual([{ collection: "posts", id: "hello", change: "delete" }])
    expect(await posts.get("hello")).toBeNull()
    expect(await content.publish()).toEqual({ revision: null, documents: [] })
  })

  it("guards publish with ifHead and rejects unknown ids", async () => {
    const { content, posts } = await setup()
    await posts.save("hello", hello)
    await expect(content.publish({ ifHead: "0".repeat(64) })).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT", details: { ref: "published", actual: null } })
    const published = await content.publish({ ifHead: null })
    await posts.save("hello", { ...hello, body: "Next" })
    await expect(content.publish({ ifHead: null })).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
    await content.publish({ ifHead: published.revision!.id })
    await expect(content.publish({ collection: "posts", ids: ["missing"] })).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND" })
    await expect(content.publish({ ids: ["hello"] } as never)).rejects.toMatchObject({ code: "CONTENT_R0009" })
  })

  it("publishes exactly the reviewed drafts with expect", async () => {
    const { content, posts } = await setup()
    await posts.save("hello", hello)
    await posts.save("other", { ...hello, data: { ...hello.data, title: "Other" } })
    const reviewed = (await posts.status()).map(({ collection, id, draft }) => ({ collection, id, digest: draft }))
    const [helloDraft] = reviewed
    const result = await content.publish({ expect: [helloDraft!], message: "Approved hello" })
    expect(result.documents).toEqual([{ collection: "posts", id: "hello", change: "add" }])
    expect(await posts.status("other")).toMatchObject({ state: "draft" })

    // A draft saved after review is not published, and nothing else is either.
    const edited = await posts.save("other", { ...hello, data: { ...hello.data, title: "Edited after review" } })
    const conflict = await rejection(content.publish({ expect: reviewed }))
    expect(isWorkspaceConflict(conflict)).toBe(true)
    expect(conflict.details).toEqual({
      ref: "draft",
      documents: [{ collection: "posts", id: "other", expected: reviewed[1]!.digest, actual: edited.digest }],
    })
    expect(conflict.message).toContain("posts/other")
    expect(await posts.get("other")).toBeNull()

    // Documents that already match published are skipped.
    expect(await content.publish({ expect: [helloDraft!, { collection: "posts", id: "other", digest: edited.digest }] })).toMatchObject({
      documents: [{ collection: "posts", id: "other", change: "add" }],
    })
    expect(await content.publish({ expect: [helloDraft!] })).toEqual({ revision: null, documents: [] })
  })

  it("publishes an expected deletion and rejects ambiguous expect options", async () => {
    const { content, posts } = await setup()
    const saved = await posts.save("hello", hello)
    await content.publish()
    // The draft still holds the document, so expecting it deleted conflicts.
    await expect(content.publish({ expect: [{ collection: "posts", id: "hello", digest: null }] })).rejects.toMatchObject({
      code: "WORKSPACE_CONFLICT",
      details: { documents: [{ collection: "posts", id: "hello", expected: null, actual: saved.digest }] },
    })
    await posts.remove("hello")
    expect(await posts.status("hello")).toMatchObject({ state: "deleted", draft: null })
    expect((await content.publish({ expect: [{ collection: "posts", id: "hello", digest: null }] })).documents).toEqual([
      { collection: "posts", id: "hello", change: "delete" },
    ])
    expect(await posts.get("hello")).toBeNull()
    // A deletion of a document that was never published publishes nothing.
    expect(await content.publish({ expect: [{ collection: "posts", id: "never", digest: null }] })).toEqual({ revision: null, documents: [] })

    const entry = { collection: "posts", id: "hello", digest: null }
    await expect(content.publish({ collection: "posts", expect: [entry] })).rejects.toMatchObject({ code: "CONTENT_R0009" })
    await expect(content.publish({ collection: "posts", ids: ["hello"], expect: [entry] })).rejects.toMatchObject({ code: "CONTENT_R0009" })
    await expect(content.publish({ expect: [] })).rejects.toMatchObject({ code: "CONTENT_R0009" })
    await expect(content.publish({ expect: [entry, entry] })).rejects.toMatchObject({ code: "CONTENT_R0009" })
    await expect(content.publish({ expect: [{ ...entry, digest: "" }] })).rejects.toMatchObject({ code: "CONTENT_R0009" })
    await expect(content.publish({ expect: [{ ...entry, collection: "pages" }] })).rejects.toMatchObject({ code: "CONTENT_R0008" })
  })

  it("lists revisions per document, reads them, and restores one", async () => {
    const { content, posts } = await setup()
    const first = await posts.save("hello", hello, { metadata: { author: "ada" } })
    await posts.save("other", hello)
    const second = await posts.save("hello", { ...hello, body: "Second" })
    await content.publish()
    const history = await content.revisions("posts", "hello")
    expect(history.revisions.map(revision => revision.id)).toEqual([second.revision, first.revision])
    expect(history.revisions[1]).toMatchObject({ message: "Save posts/hello", metadata: { author: "ada", content: { action: "save" } } })
    expect((await content.revisions("posts", "hello", { limit: 1 })).cursor).toBe(second.revision)
    expect((await content.revisions("posts", "hello", { ref: "published" })).revisions).toHaveLength(1)
    expect((await posts.get("hello", { revision: first.revision }))?.body).toBe(hello.body)

    const restored = await posts.restore("hello", first.revision, { ifDigest: second.digest })
    expect(restored).toMatchObject({ body: hello.body, digest: first.digest })
    expect(await posts.status("hello")).toMatchObject({ state: "changed" })
    expect((await content.revisions("posts", "hello")).revisions[0]).toMatchObject({ id: restored.revision, metadata: { content: { action: "restore" } } })
  })

  it("lists with filters, search, sort, facets, totals, and cursors", async () => {
    const { content, posts } = await setup()
    await posts.save("vue-one", { data: { title: "Vue One", date: "2026-01-02", tags: ["vue"] }, body: "Signals" })
    await posts.save("vue-two", { data: { title: "Vue Two", date: "2026-03-01", tags: ["vue", "ssr"] }, body: "Hydration" })
    await posts.save("2026/react", { data: { title: "React", date: "2026-02-01", tags: ["react"] }, body: "Hooks" })
    expect((await posts.list()).total).toBe(0)
    await content.publish()

    const all = await posts.list({ sort: { field: "date", direction: "desc" }, facets: ["tags"] })
    expect(all.items.map(item => item.id)).toEqual(["vue-two", "2026/react", "vue-one"])
    expect(all.total).toBe(3)
    expect(all.facets?.tags).toEqual(expect.arrayContaining([{ value: "vue", count: 2 }, { value: "ssr", count: 1 }]))
    expect(all.items[0]).not.toHaveProperty("body")

    expect((await posts.list({ filter: { tags: "vue" } })).items.map(item => item.id)).toEqual(["vue-one", "vue-two"])
    expect((await posts.list({ filter: { date: new Date("2026-02-01") } })).items.map(item => item.id)).toEqual(["2026/react"])
    expect((await posts.list({ search: "hydration" })).items.map(item => item.id)).toEqual(["vue-two"])

    const page = await posts.list({ sort: { field: "title" }, limit: 2 })
    expect(page).toMatchObject({ total: 3, nextCursor: expect.any(String) })
    const rest = await posts.list({ sort: { field: "title" }, limit: 2, cursor: page.nextCursor! })
    expect(rest.items.map(item => item.id)).toEqual(["vue-two"])

    await posts.save("vue-one", { data: { title: "Vue One!", date: "2026-01-02" }, body: "Changed" })
    expect((await posts.list({ ref: "draft", filter: { id: "vue-one" } })).items[0]?.data.title).toBe("Vue One!")
    await content.publish()
    await expect(posts.list({ sort: { field: "title" }, limit: 2, cursor: page.nextCursor! })).rejects.toMatchObject({ reason: "stale" })
  })

  it("reports when each document last changed on the ref it was read from", async () => {
    const { content, posts, workspace } = await setup()
    const first = await posts.save("first", hello)
    const second = await posts.save("second", hello)
    const { revision: published } = await content.publish({ collection: "posts", ids: ["first"] })
    const edited = await posts.save("first", { ...hello, body: "Edited" })
    const updatedAt = (page: { items: Array<{ id: string, updatedAt: string | null }> }) => Object.fromEntries(page.items.map(item => [item.id, item.updatedAt]))
    // This answer is cached, and the next walk stops at it.
    expect(updatedAt(await posts.list({ ref: "draft" }))).toEqual({ first: edited.updatedAt, second: second.updatedAt })
    const facade = useWorkspace(workspace as never, { mode: "write" })
    const head = await facade.history.head({ ref: "draft" })
    const foreign = await facade.history.commit({ ref: "draft", ifHead: head!.id, changes: { put: { "posts/third.md": "---\ntitle: Third\ndate: 2026-01-01\n---\n" } } })

    const draft = { first: edited.revision, second: second.revision, third: foreign.id }
    const createdAt = async (id: string) => (await (await facade.history.open(id)).revision).createdAt
    const expected = { first: await createdAt(draft.first), second: await createdAt(draft.second), third: foreign.createdAt }
    expect(edited.updatedAt).toBe(expected.first)
    expect(first.updatedAt).not.toBe(edited.updatedAt)
    expect(updatedAt(await posts.list({ ref: "draft" }))).toEqual(expected)
    expect(updatedAt(await posts.list())).toEqual({ first: published!.createdAt })
    expect((await posts.get("second", { ref: "draft" }))?.updatedAt).toBe(expected.second)

    // Another runtime walks the history cold and reaches the same answer.
    const other = defineContent({ workspace, collections: { posts: documents({ path: "posts/**/*.md", fields }) }, logger: false })
    cleanup.push(() => other.dispose())
    expect(updatedAt(await other.collection("posts").list({ ref: "draft" }))).toEqual(expected)
  })

  it("serves only published documents from /api/content and refreshes Comark after publish", async () => {
    const { content, posts } = await setup()
    await posts.save("hello", hello)
    const read = async () => await content.handler(new Request("https://example.test/api/content/get/posts/hello"))
    expect(await (await read()).json()).toBeNull()
    await content.publish()
    const published = await read()
    expect(published.status).toBe(200)
    expect(await published.json()).toMatchObject({ path: "/posts/hello", data: { title: "Hello" } })

    await posts.save("hello", { ...hello, data: { ...hello.data, title: "Draft title" } })
    expect(await (await read()).json()).toMatchObject({ data: { title: "Hello" } })
    expect(await content.get("/posts/hello")).toMatchObject({ data: { title: "Hello" } })

    await content.publish()
    expect(await (await read()).json()).toMatchObject({ data: { title: "Draft title" } })
    expect(await content.list("posts")).toEqual([expect.objectContaining({ path: "/posts/hello" })])
  })

  it("is a read-only Collection over published documents", async () => {
    const { content, posts } = await setup()
    await posts.save("vue", { data: { title: "Vue", date: "2026-01-02", tags: ["vue"] }, body: "Body" })
    await posts.save("react", { data: { title: "React", date: "2026-01-03", tags: ["react"] } })
    await content.publish({ collection: "posts", ids: ["vue"] })
    await posts.save("draft-only", { data: { title: "Draft", date: "2026-01-04", tags: ["vue"] } })
    const app = new H3().get("/posts", defineCollectionHandler(posts))
    const response = await app.request("/posts?tags=vue")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      items: [{ collection: "posts", id: "vue", path: "posts/vue.md", data: { title: "Vue", date: "2026-01-02T00:00:00.000Z", tags: ["vue"] }, digest: expect.any(String), revision: expect.any(String), updatedAt: expect.any(String) }],
      nextCursor: null,
      total: 1,
    })
    expect((await app.request("/posts?secret=1")).status).toBe(400)
  })

  it("refreshes Comark when another runtime publishes", async () => {
    const { content, posts, workspace } = await setup()
    await posts.save("hello", hello)
    await content.publish()
    expect(await content.get("/posts/hello")).toMatchObject({ data: { title: "Hello" } })

    const other = defineContent({ workspace, collections: { posts: documents({ path: "posts/**/*.md", fields }) }, logger: false })
    cleanup.push(() => other.dispose())
    await other.collection("posts").save("hello", { ...hello, data: { ...hello.data, title: "From elsewhere" } })
    await other.publish()
    expect(await content.get("/posts/hello")).toMatchObject({ data: { title: "From elsewhere" } })
  })

  it("skips documents that stopped validating in list() and explains them in get()", async () => {
    const { content, posts, workspace } = await setup()
    await posts.save("hello", hello)
    await posts.save("untagged", { data: { title: "Untagged", date: "2026-01-01" } })
    await content.publish()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const stricter = defineContent({
      workspace,
      collections: { posts: documents({ path: "posts/**/*.md", fields: { ...fields, tags: z.array(z.string()).min(1) } }) },
      logger: false,
    })
    cleanup.push(() => stricter.dispose())
    expect((await stricter.collection("posts").list()).items.map(item => item.id)).toEqual(["hello"])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("posts/untagged"))
    await expect(stricter.collection("posts").get("untagged")).rejects.toMatchObject({ code: "CONTENT_INVALID", details: { issues: [expect.objectContaining({ field: "tags" })] } })
  })

  it("refuses to publish a draft that no longer validates", async () => {
    const { posts, workspace } = await setup()
    await posts.save("untagged", { data: { title: "Untagged", date: "2026-01-01" } })
    const stricter = defineContent({
      workspace,
      collections: { posts: documents({ path: "posts/**/*.md", fields: { ...fields, tags: z.array(z.string()).min(1) } }) },
      logger: false,
    })
    cleanup.push(() => stricter.dispose())
    await expect(stricter.publish()).rejects.toMatchObject({ code: "CONTENT_INVALID", details: { id: "untagged", issues: [expect.objectContaining({ field: "tags" })] } })
    expect(await posts.status("untagged")).toMatchObject({ state: "draft", published: null })
  })

  it("reads the stored file with raw() even when it no longer validates", async () => {
    const { content, posts, workspace } = await setup()
    await posts.save("untagged", { data: { title: "Untagged", date: "2026-01-01" }, body: "Body" })
    await content.publish()
    const stricter = defineContent({
      workspace,
      collections: { posts: documents({ path: "posts/**/*.md", fields: { ...fields, tags: z.array(z.string()).min(1) } }) },
      logger: false,
    })
    cleanup.push(() => stricter.dispose())
    const strict = stricter.collection("posts")
    await expect(strict.get("untagged")).rejects.toMatchObject({ code: "CONTENT_INVALID" })
    const raw = await strict.raw("untagged")
    expect(raw).toEqual({
      collection: "posts",
      id: "untagged",
      path: "posts/untagged.md",
      text: "---\ntitle: Untagged\ndate: 2026-01-01\n---\n\nBody",
      digest: (await posts.status("untagged"))!.published,
      revision: expect.any(String),
    })
    expect(await strict.raw("untagged", { ref: "draft" })).toEqual({ ...raw, revision: expect.any(String) })
    expect(await strict.raw("untagged", { revision: raw!.revision })).toEqual(raw)
    expect(await strict.raw("missing")).toBeNull()
    await expect(strict.raw("untagged", { ref: "draft", revision: raw!.revision })).rejects.toMatchObject({ code: "CONTENT_R0008" })
  })

  it("pins the Comark Source to the draft ref with withRef()", async () => {
    const { content, posts } = await setup()
    await posts.save("hello", hello)
    const source = content.getSource("posts")!
    expect(await source.keys()).toEqual([])
    const draft = source.withRef!("draft")
    expect(await draft.keys()).toEqual(["posts/hello.md"])
    expect(await draft.getItem("posts/hello.md")).toContain("title: Hello")
    expect(() => source.withRef!("main")).toThrow(expect.objectContaining({ code: "CONTENT_R0008" }))
  })

  it("exposes the field JSON Schema and gives Comark its subset", async () => {
    const { content, posts } = await setup()
    expect(posts.schema).toEqual({
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        date: { type: "string", format: "date-time" },
        tags: { type: "array", items: { type: "string" }, default: [] },
        summary: {},
      },
      required: ["title", "date"],
    })
    expect(content.getSource("posts")?.schema).toEqual({
      type: "object",
      properties: { title: { type: "string" }, date: { type: "string" }, tags: { type: "array", items: { type: "string" } }, summary: {} },
      required: ["title", "date"],
    })
  })

  it("projects Valibot fields through toStandardJsonSchema() and warns once per untyped field", async () => {
    const workspace = await historyWorkspace()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const define = () => defineContent({
      workspace,
      collections: {
        events: documents({
          path: "events/*.md",
          fields: {
            title: toStandardJsonSchema(v.string()),
            day: optional(toStandardJsonSchema(v.pipe(v.string(), v.isoDate()))),
            venue: v.string(),
            ends: optional(z.coerce.date()),
            extra: z.unknown(),
          },
        }),
      },
      logger: false,
    })
    const content = define()
    cleanup.push(() => content.dispose())
    const events = content.collection("events")
    expect(events.schema).toEqual({
      type: "object",
      properties: { title: { type: "string" }, day: { type: "string", format: "date" }, venue: {}, ends: { type: "string", format: "date-time" }, extra: {} },
      required: ["title", "venue"],
    })
    expect((await events.save("launch", { data: { title: "Launch", day: "2026-10-14", venue: "Online" } })).data).toEqual({ title: "Launch", day: "2026-10-14", venue: "Online" })
    const warnings = () => warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes("\"events\""))
    expect(warnings()).toEqual([
      expect.stringContaining("field \"venue\" has no JSON Schema"),
      expect.stringContaining("field \"extra\" has no JSON Schema"),
    ])
    expect(warnings()[0]).toContain("toStandardJsonSchema() from @valibot/to-json-schema")
    expect(warnings()[1]).toContain("https://vitehub.dev/docs/content/configure#json-schema")
    const again = define()
    cleanup.push(() => again.dispose())
    expect(warnings()).toHaveLength(2)
  })

  it("treats optional() fields as absent and accepts Standard Schemas from different libraries", async () => {
    const { posts } = await setup()
    const saved = await posts.save("plain", { data: { title: "Plain", date: "2026-01-01" } })
    expect(saved.data).toEqual({ title: "Plain", date: new Date("2026-01-01"), tags: [] })
    const summary = await posts.save("summary", { data: { title: "Sum", date: "2026-01-01", summary: "Short" } })
    expect(summary.data.summary).toBe("Short")
    // @ts-expect-error summary must be a string
    await expect(posts.save("bad", { data: { title: "Bad", date: "2026-01-01", summary: 4 } })).rejects.toMatchObject({ code: "CONTENT_INVALID" })
  })

  it("rejects ids outside the collection", async () => {
    const { posts } = await setup()
    for (const id of ["", "../secret", "/abs", "a//b", "trailing/"]) {
      await expect(posts.save(id, hello)).rejects.toMatchObject({ code: "CONTENT_R0008" })
    }
  })

  it("fails clearly without retained history", async () => {
    registerWorkspace("memory-content", { store: { provider: "memory" } })
    const content = defineContent({ workspace: "memory-content", collections: { posts: documents({ path: "posts/*.md", fields }) } })
    cleanup.push(() => content.dispose())
    await expect(content.collection("posts").save("hello", hello)).rejects.toMatchObject({ code: "CONTENT_R0007" })
  })

  it("evaluates authorize through can() and denies without a policy", async () => {
    const { content } = await setup()
    expect(await content.can({ user: { role: "editor" }, collection: "posts", action: "write" })).toBe(false)
    const policy = vi.fn(({ user, action }: { user: Record<string, unknown> | null | undefined, action: string }) => user?.role === "editor" && action !== "publish")
    const { content: guarded } = await setup({ authorize: policy })
    expect(await guarded.can({ user: { role: "editor" }, collection: "posts", action: "write", id: "hello" })).toBe(true)
    expect(await guarded.can({ user: { role: "editor" }, collection: "posts", action: "publish" })).toBe(false)
    expect(await guarded.can({ user: null, collection: "posts", action: "read" })).toBe(false)
    expect(policy).toHaveBeenCalledWith({ user: { role: "editor" }, collection: "posts", action: "write", id: "hello" })
    // @ts-expect-error unknown collection
    await expect(guarded.can({ user: null, collection: "pages", action: "read" })).rejects.toMatchObject({ code: "CONTENT_R0008" })
  })

  it("passes the Auth user and the Agent Actor to authorize", async () => {
    const policy = vi.fn<ContentAuthorize>(({ user, actor, action }) => user?.role === "editor" || (action === "read" && actor?.kind === "agent"))
    const { content } = await setup({ authorize: policy })
    const actor = { id: "agent:writer", kind: "agent", meta: { authUserId: "u1" } }
    expect(await content.can({ actor, collection: "posts", action: "read" })).toBe(true)
    expect(policy).toHaveBeenLastCalledWith({ user: null, actor, collection: "posts", action: "read" })
    expect(await content.can({ user: { role: "editor" }, actor, collection: "posts", action: "publish", id: "hello" })).toBe(true)
    expect(policy).toHaveBeenLastCalledWith({ user: { role: "editor" }, actor, collection: "posts", action: "publish", id: "hello" })
    expect(await content.can({ actor, collection: "posts", action: "write" })).toBe(false)
    await expect(content.can({ actor: { kind: "agent" } as never, collection: "posts", action: "read" })).rejects.toMatchObject({ code: "CONTENT_R0008" })
    await expect(content.can({ user: "editor" as never, collection: "posts", action: "read" })).rejects.toMatchObject({ code: "CONTENT_R0008" })
  })

  it("keeps read-only sources next to collections and rejects bad definitions", async () => {
    const workspace = await historyWorkspace()
    const docs = { keys: () => ["index.md"], getItem: () => "# Docs", getItemRaw: () => "# Docs" }
    const content = defineContent({ workspace, sources: { docs }, collections: { posts: documents({ path: "posts/*.md", fields }) }, logger: false })
    cleanup.push(() => content.dispose())
    expect(await content.list("docs")).toEqual([expect.objectContaining({ path: "/" })])
    expect(content.getSource("posts")).toBeDefined()
    const [posts, ...rest] = content.collections()
    expect(rest).toEqual([])
    expect(posts).toBe(content.collection("posts"))
    expect(posts).toMatchObject({ name: "posts", path: "posts/*.md", fields: ["title", "date", "tags", "summary"], schema: { type: "object" } })
    const sourcesOnly = defineContent({ sources: { docs }, logger: false })
    cleanup.push(() => sourcesOnly.dispose())
    expect(sourcesOnly.collections()).toEqual([])

    expect(() => defineContent({ collections: { posts: documents({ path: "posts/*.md", fields }) } })).toThrow(expect.objectContaining({ code: "CONTENT_R0006" }))
    expect(() => defineContent({ workspace, sources: { posts: docs }, collections: { posts: documents({ path: "posts/*.md", fields }) } })).toThrow("same name")
    expect(() => documents({ path: "posts/**", fields })).toThrow("must end with one extension")
    expect(() => documents({ path: "posts/{a,b}/*.md", fields })).toThrow("only *, **, and ?")
    expect(() => documents({ path: "posts/*.md", fields: { title: "string" as never } })).toThrow("Standard Schema")
  })

  it("types data from field outputs and save input from field inputs", async () => {
    const { content, posts } = await setup()
    const document = await posts.get("hello")
    expectTypeOf(document).toEqualTypeOf<ContentDocument<{ title: string, date: Date, tags: string[], summary?: string | undefined }> | null>()
    expectTypeOf(posts.save).parameter(1).toHaveProperty("data").toEqualTypeOf<{ title: string, date?: unknown, tags?: string[] | undefined, summary?: string | undefined }>()
    // @ts-expect-error only defined collections can be opened
    expect(() => content.collection("pages")).toThrow(expect.objectContaining({ code: "CONTENT_R0008" }))
    expectTypeOf<StandardSchemaV1.InferOutput<ReturnType<typeof optional<typeof fields.title>>>>().toEqualTypeOf<string | undefined>()
  })
})
