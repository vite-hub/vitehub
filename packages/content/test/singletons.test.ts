import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import { z } from "zod"

import { useWorkspace } from "@vite-hub/workspace"
import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { parseDocumentFile, renderDocumentFile } from "../src/documents.ts"
import { defineContent, documents, singleton } from "../src/index.ts"
import { createContentConsoleActions } from "../src/runtime/console.ts"
import { contentConsoleSection } from "../src/vite.ts"

import type { AnyContentCollection, ContentDocument, ContentDocumentStatus, ContentFormat, ContentSingleton } from "../src/index.ts"

const migration = await readFile(new URL("../../workspace/test/fixtures/history.sql", import.meta.url), "utf8")
const cleanup: Array<() => Promise<void> | void> = []
let workspaces = 0

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-single-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** A Workspace on the Blob + Database Store, as the Workspace history tests use. */
async function historyWorkspace(): Promise<string> {
  const root = await temporaryRoot()
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle(client, { schema: workspaceHistorySchema })
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  const name = `single-${++workspaces}`
  registerWorkspace(name, { store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: name }) })
  return name
}

const settingsFields = {
  title: z.string().min(1),
  description: z.string().max(160).optional(),
  social: z.array(z.url()).default([]),
  theme: z.object({ accent: z.string(), dark: z.boolean().default(false) }).optional(),
}

async function setup(path = "settings.json") {
  const workspace = await historyWorkspace()
  const content = defineContent({
    workspace,
    collections: {
      settings: singleton({ path, fields: settingsFields }),
      authors: documents({ path: "authors/*.yaml", fields: { name: z.string(), links: z.array(z.object({ label: z.string(), url: z.url() })).default([]) } }),
      posts: documents({ path: "posts/*.md", fields: { title: z.string(), author: z.object({ name: z.string(), url: z.url().optional() }).optional() } }),
    },
    authorize: () => true,
    logger: false,
  })
  cleanup.push(() => content.dispose())
  return { content, workspace, settings: content.collection("settings"), authors: content.collection("authors"), posts: content.collection("posts") }
}

const site = {
  title: "ViteHub",
  description: "Server primitives for any host.",
  social: ["https://github.com/vite-hub", "https://x.com/vitehub"],
  theme: { accent: "#000", dark: true },
}

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
  }
  catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject.")
}

describe("document formats", () => {
  const data = { title: "Hello", author: { name: "Ada", links: [{ label: "Site", url: "https://ada.dev" }] }, tags: ["a", "b"], long: `${"word ".repeat(40)}end` }

  it.each<[ContentFormat, string]>([
    ["json", `${JSON.stringify(data, null, 2)}\n`],
    ["yaml", [
      "title: Hello",
      "author:",
      "  name: Ada",
      "  links:",
      "    - label: Site",
      "      url: https://ada.dev",
      "tags:",
      "  - a",
      "  - b",
      `long: ${"word ".repeat(40)}end`,
      "",
    ].join("\n")],
  ])("stores %s as diff-friendly text and reads it back", (format, text) => {
    expect(renderDocumentFile(data, "", format)).toBe(text)
    expect(parseDocumentFile(text, format)).toEqual({ frontmatter: data, body: "" })
    // A second round trip is byte for byte the same.
    expect(renderDocumentFile(data, "", format)).toBe(renderDocumentFile((parseDocumentFile(text, format) as { frontmatter: Record<string, unknown> }).frontmatter, "", format))
  })

  it("keeps nested frontmatter as YAML blocks, not JSON, with long values on one line", () => {
    const text = renderDocumentFile({ title: "Hi", author: { name: "Ada", url: "https://ada.dev" } }, "Body\n")
    expect(text).toBe("---\ntitle: Hi\nauthor:\n  name: Ada\n  url: https://ada.dev\n---\n\nBody\n")
    expect(renderDocumentFile({ summary: "x ".repeat(80) }, "")).not.toContain("\n  x")
  })

  it("rejects files that are not one object", () => {
    expect(parseDocumentFile("[1, 2]", "json")).toMatchObject({ issues: [{ message: expect.stringContaining("one object") }] })
    expect(parseDocumentFile("{ nope", "json")).toMatchObject({ issues: [{ message: expect.stringContaining("not valid JSON") }] })
    expect(parseDocumentFile("- a\n- b\n", "yaml")).toMatchObject({ issues: [{ message: expect.stringContaining("one mapping") }] })
    expect(parseDocumentFile("a: [\n", "yaml")).toMatchObject({ issues: [{ message: expect.stringContaining("not valid YAML") }] })
    expect(parseDocumentFile("", "yaml")).toEqual({ frontmatter: {}, body: "" })
  })
})

describe("singleton() definitions", () => {
  it("defines one file with its format and id", () => {
    expect(singleton({ path: "./config/site.yml", fields: {} })).toMatchObject({ kind: "singleton", path: "config/site.yml", format: "yaml" })
    expect(documents({ path: "authors/*.json", fields: {} })).toMatchObject({ kind: "documents", format: "json" })
    expect(documents({ path: "posts/**/*.md", fields: {} })).toMatchObject({ kind: "documents", format: "markdown" })
  })

  it("points at the other helper when the path does not fit", () => {
    expect(() => documents({ path: "settings.json", fields: {} })).toThrow(/Use singleton\(\{ path: "settings.json" \}\)/)
    expect(() => singleton({ path: "posts/*.md", fields: {} })).toThrow(/Use documents\(\{ path: "posts\/\*\.md" \}\)/)
    expect(() => singleton({ path: "settings", fields: {} })).toThrow(/must end with an extension/)
    expect(() => singleton({ path: "../settings.json", fields: {} })).toThrow(/relative file path/)
    // @ts-expect-error fields must be validators
    expect(() => singleton({ path: "settings.json", fields: { title: "string" } })).toThrow(/Standard Schema/)
  })
})

describe("singletons", { timeout: 30_000 }, () => {
  it("saves, publishes with expect, restores, and removes without an id", async () => {
    const { content, settings } = await setup()
    expect(settings).toMatchObject({ kind: "singleton", id: "settings", path: "settings.json", format: "json", fields: ["title", "description", "social", "theme"] })
    expect(await settings.get()).toBeNull()
    expect(await settings.status()).toBeNull()

    // Fields are stored in definition order whatever order the writer sends.
    const first = await settings.save({ data: { social: site.social, theme: site.theme, title: site.title, description: site.description } }, { ifDigest: null })
    expect(first).toMatchObject({ collection: "settings", id: "settings", path: "settings.json", body: "", data: site })
    expect((await settings.raw({ ref: "draft" }))?.text).toBe(`${JSON.stringify(site, null, 2)}\n`)
    expect(await settings.status()).toEqual({ collection: "settings", id: "settings", state: "draft", draft: first.digest, published: null })

    // A draft saved after review is not published.
    const reviewed = first.digest
    const second = await settings.save({ data: { ...site, title: "ViteHub 2" } }, { ifDigest: reviewed })
    await expect(content.publish({ expect: [{ collection: "settings", digest: reviewed }] })).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
    const published = await content.publish({ expect: [{ collection: "settings", digest: second.digest }] })
    expect(published.documents).toEqual([{ collection: "settings", id: "settings", change: "add" }])
    expect(await settings.get()).toMatchObject({ data: { title: "ViteHub 2" }, digest: second.digest })

    // Draft revisions, newest first: the second save, then the first.
    const { revisions } = await content.revisions("settings")
    expect(revisions.map(revision => revision.message)).toEqual(["Save settings/settings", "Save settings/settings"])
    const restored = await settings.restore(revisions[1]!.id)
    expect(restored).toMatchObject({ data: { title: "ViteHub" }, digest: first.digest })
    expect(await settings.status()).toMatchObject({ state: "changed" })

    await settings.remove()
    expect(await settings.status()).toMatchObject({ state: "deleted", draft: null })
    await content.publish({ expect: [{ collection: "settings", digest: null }] })
    expect(await settings.status()).toBeNull()
  })

  it("accepts its own id from generic code and rejects any other", async () => {
    const { content, settings } = await setup()
    const generic: AnyContentCollection = content.collections().find(collection => collection.name === "settings")!
    expect(generic).toBe(settings)
    if (generic.kind !== "singleton") throw new Error("Expected a singleton.")
    const saved = await generic.save("settings", { data: site })
    expect(await generic.get("settings", { ref: "draft" })).toEqual(saved)
    expect(await generic.status("settings")).toMatchObject({ state: "draft" })
    expect((await generic.list({ ref: "draft" })).items.map(item => item.id)).toEqual(["settings"])
    await expect(generic.restore("settings", saved.revision)).resolves.toMatchObject({ digest: saved.digest })
    expect(await rejection(settings.get("other"))).toMatchObject({ code: "CONTENT_R0008", message: expect.stringContaining("Omit the id") })
    await expect(content.publish({ expect: [{ collection: "posts", digest: null }] })).rejects.toMatchObject({ code: "CONTENT_R0008" })
  })

  it("validates JSON and YAML from every Workspace writer and rejects a body", async () => {
    const { settings, workspace } = await setup()
    const facade = useWorkspace(workspace as never, { mode: "write" })
    await expect(facade.fs.writeFile("settings.json" as never, "{ \"title\": 1 }")).rejects.toMatchObject({ code: "CONTENT_INVALID", details: { id: "settings" } })
    await expect(facade.fs.writeFile("settings.json" as never, "[]")).rejects.toMatchObject({ code: "CONTENT_INVALID" })
    await expect(facade.fs.writeFile("authors/ada.yaml" as never, "name: [unclosed\n")).rejects.toMatchObject({ code: "CONTENT_INVALID" })
    await expect(facade.fs.writeFile("authors/ada.yaml" as never, "links:\n  - label: Site\n    url: not a url\n")).rejects.toMatchObject({
      code: "CONTENT_INVALID",
      details: { issues: expect.arrayContaining([expect.objectContaining({ field: "name" }), expect.objectContaining({ field: "links", path: [0, "url"] })]) },
    })
    expect(await rejection(settings.save({ data: site, body: "# Hi" }))).toMatchObject({ code: "CONTENT_INVALID", details: { issues: [{ path: ["body"], message: expect.stringContaining("JSON documents have no body") }] } })
    expect(await rejection(settings.save({ data: { ...site, social: ["nope"] } }))).toMatchObject({ code: "CONTENT_INVALID", details: { issues: [expect.objectContaining({ field: "social", path: [0] })] } })
  })

  it("lists, searches, and stores collections of data files", async () => {
    const { authors } = await setup()
    expect(authors).toMatchObject({ kind: "documents", format: "yaml" })
    await authors.save("ada", { data: { name: "Ada Lovelace", links: [{ label: "Site", url: "https://ada.dev" }] } })
    await authors.save("grace", { data: { name: "Grace Hopper" } })
    expect((await authors.raw("ada", { ref: "draft" }))?.text).toBe("name: Ada Lovelace\nlinks:\n  - label: Site\n    url: https://ada.dev\n")
    const page = await authors.list({ ref: "draft", search: "grace" })
    expect(page.items).toEqual([expect.objectContaining({ id: "grace", path: "authors/grace.yaml", data: { name: "Grace Hopper", links: [] } })])
  })

  it("serves published singletons and data files from /api/content", async () => {
    const { content, settings, authors } = await setup()
    await settings.save({ data: site })
    await authors.save("ada", { data: { name: "Ada" } })
    const read = async (path: string) => await (await content.handler(new Request(`https://example.test/api/content/get/${path}`))).json()
    expect(await read("settings")).toBeNull()
    await content.publish()
    expect(await read("settings")).toMatchObject({ path: "/settings", data: site })
    expect(await read("authors/ada")).toMatchObject({ path: "/authors/ada", data: { name: "Ada" } })
  })

  it("describes the kind and format of every collection", async () => {
    const { content } = await setup("config/site.yaml")
    expect(content.collections().map(({ name, kind, format, path }) => ({ name, kind, format, path }))).toEqual([
      { name: "settings", kind: "singleton", format: "yaml", path: "config/site.yaml" },
      { name: "authors", kind: "documents", format: "yaml", path: "authors/*.yaml" },
      { name: "posts", kind: "documents", format: "markdown", path: "posts/*.md" },
    ])
    expect(content.collection("settings").id).toBe("site")
  })

  it("types singletons without ids", async () => {
    const { content, settings } = await setup()
    expectTypeOf(settings).toEqualTypeOf<ContentSingleton<typeof settingsFields>>()
    expectTypeOf(settings.get).returns.resolves.toEqualTypeOf<ContentDocument<{
      title: string
      social: string[]
      description?: string | undefined
      theme?: { accent: string, dark: boolean } | undefined
    }> | null>()
    expectTypeOf(settings.status).returns.resolves.toEqualTypeOf<ContentDocumentStatus | null>()
    // Generic code calls the id methods of any collection without narrowing, as Agents and the CLI do.
    type Any = ReturnType<typeof content.collections>[number]
    expectTypeOf<Any["get"]>().toBeCallableWith("settings", { ref: "draft" })
    expectTypeOf<Any["save"]>().toBeCallableWith("settings", { data: {} }, { ifDigest: null })
    expectTypeOf<Any["status"]>().toBeCallableWith("settings")
    expectTypeOf<Any["restore"]>().toBeCallableWith("settings", "revision")
  })
})

describe("singletons in the Console", { timeout: 30_000 }, () => {
  const editor = { user: { id: "ada", role: "editor" } }

  it("describes singletons and edits them by id", async () => {
    const { content } = await setup()
    const actions = createContentConsoleActions({ content })
    const collections = await actions.collections(editor)
    expect(collections.find(collection => collection.name === "settings")).toMatchObject({ kind: "singleton", document: "settings", format: "json", titleField: "title" })
    expect(collections.find(collection => collection.name === "posts")).toMatchObject({ kind: "documents", format: "markdown" })
    expect(collections.find(collection => collection.name === "posts")).not.toHaveProperty("document")
    const saved = await actions.save({ collection: "settings", id: "settings", data: site, body: "", ifDigest: null }, editor)
    expect(saved).toMatchObject({ id: "settings", body: "", state: "draft" })
    const page = await actions.list({ collection: "settings" }, editor)
    expect(page).toMatchObject({ total: 1, states: { draft: 1 }, changes: [{ id: "settings", digest: saved.digest }] })
    await expect(actions.publish({ collection: "settings", expect: [{ id: "settings", digest: saved.digest }] }, editor)).resolves.toMatchObject({ documents: [{ change: "add" }] })
  })

  it("keeps the Content section for collections defined with singleton()", async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, "server"), { recursive: true })
    await writeFile(join(root, "server/content.ts"), `import { defineContent, singleton } from "vite-hub/content"\nexport const content = defineContent({ workspace: "site", collections: { settings: singleton({ path: "settings.json", fields: {} }) } })\n`)
    await expect(contentConsoleSection.entry({ projectRoot: root })).resolves.toBe(join(root, "server/content.ts"))
  })
})
