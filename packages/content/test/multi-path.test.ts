import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { useWorkspace } from "@vite-hub/workspace"

import { documents, singleton } from "../src/collections.ts"
import { defineContent } from "../src/index.ts"
import { createContentConsoleActions } from "../src/runtime/console.ts"
import { historyWorkspace } from "./history-workspace.ts"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

const fields = { title: z.string() }

function errorOf(run: () => unknown): Error & { code?: string } {
  try {
    run()
  }
  catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error("Expected an error.")
}

describe("documents({ path: [...] })", () => {
  it("keeps every glob and shows them together", () => {
    const definition = documents({ path: ["content/posts/**/*.md", "content/news/*.md"], fields })
    expect(definition.paths).toEqual(["content/posts/**/*.md", "content/news/*.md"])
    expect(definition.path).toBe("content/posts/**/*.md, content/news/*.md")
    expect(documents({ path: "posts/*.md", fields }).paths).toEqual(["posts/*.md"])
    expect(documents({ path: "posts/*.md", fields }).path).toBe("posts/*.md")
    expect(singleton({ path: "settings.json", fields }).paths).toEqual(["settings.json"])
  })

  it("rejects an empty list, a repeated glob, a path without a wildcard, and mixed extensions", () => {
    expect(errorOf(() => documents({ path: [], fields })).code).toBe("CONTENT_R0006")
    expect(errorOf(() => documents({ path: ["posts/*.md", "posts/*.md"], fields })).message).toContain("list a glob twice")
    expect(errorOf(() => documents({ path: ["posts/*.md", "about.md"], fields })).message).toContain("has no wildcard")
    const mixed = errorOf(() => documents({ path: ["posts/*.md", "data/*.json"], fields }))
    expect(mixed.code).toBe("CONTENT_R0006")
    expect(mixed.message).toContain("must share one extension")
  })
})

describe("collections with several globs", () => {
  async function setup(path: string[], extra: Record<string, ReturnType<typeof documents>> = {}) {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({ workspace, collections: { pages: documents({ path, fields }), ...extra }, logger: false })
    cleanup.push(() => content.dispose())
    return { content, pages: content.collection("pages"), workspace }
  }

  it("names ids from the folder that the globs share", async () => {
    const { content, pages } = await setup(["content/posts/**/*.md", "content/news/*.md"])
    const saved = await pages.save("posts/2026/hello", { data: { title: "Hello" }, body: "" })
    expect(saved.path).toBe("content/posts/2026/hello.md")
    expect((await pages.save("news/launch", { data: { title: "Launch" }, body: "" })).path).toBe("content/news/launch.md")
    await content.publish()
    expect((await pages.list()).items.map(item => item.id).sort()).toEqual(["news/launch", "posts/2026/hello"])
    expect(await pages.get("news/launch")).toMatchObject({ data: { title: "Launch" } })
    // A path outside every glob is not a document of the collection.
    await expect(pages.save("press/note", { data: { title: "No" }, body: "" })).rejects.toMatchObject({ code: "CONTENT_R0008", message: expect.stringContaining("outside collection") })
    await expect(pages.save("news/deep/note", { data: { title: "No" }, body: "" })).rejects.toMatchObject({ code: "CONTENT_R0008" })
  })

  it("uses the whole path as the id when the globs share no folder", async () => {
    const { pages } = await setup(["posts/*.md", "news/*.md"])
    expect((await pages.save("posts/a", { data: { title: "A" }, body: "" })).path).toBe("posts/a.md")
    expect((await pages.save("news/b", { data: { title: "B" }, body: "" })).path).toBe("news/b.md")
    expect((await pages.list({ ref: "draft" })).items.map(item => item.id).sort()).toEqual(["news/b", "posts/a"])
  })

  it("checks every pair of globs for overlap between collections", () => {
    const overlap = (left: string[], right: string[]) => async () => {
      const workspace = await historyWorkspace(cleanup)
      return defineContent({ workspace, collections: { left: documents({ path: left, fields }), right: documents({ path: right, fields }) }, logger: false })
    }
    return Promise.all([
      expect(overlap(["a/*.md", "b/*.md"], ["c/*.md", "b/x*.md"])()).rejects.toMatchObject({ message: expect.stringContaining("overlap") }),
      expect(overlap(["a/*.md", "b/*.md"], ["c/*.md", "d/**/*.md"])()).resolves.toBeDefined(),
    ])
  })

  it("lists only the folders of the globs when it reads a revision", async () => {
    const listed: string[] = []
    const workspace = await historyWorkspace(cleanup, {
      wrap(store) {
        const open = store.history.open.bind(store.history)
        store.history = {
          ...store.history,
          open: async (id) => {
            const view = await open(id)
            return { ...view, revision: view.revision, list: async (path, options) => { listed.push(path ?? ""); return await view.list(path, options) }, stat: view.stat, readFile: view.readFile }
          },
        }
      },
    })
    const content = defineContent({ workspace, collections: { pages: documents({ path: ["content/posts/**/*.md", "content/news/*.md"], fields }) }, logger: false })
    cleanup.push(() => content.dispose())
    await content.collection("pages").save("posts/a", { data: { title: "A" }, body: "" })
    await content.publish()
    await content.collection("pages").list()
    expect(listed.length).toBeGreaterThan(0)
    expect(new Set(listed)).toEqual(new Set(["content/posts", "content/news"]))
  })
})

describe("Console collections with several globs", () => {
  it("send every glob", async () => {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({
      workspace,
      collections: { pages: documents({ path: ["docs/pages/**/*.md", "packages/*/docs/**/*.md"], fields }), notes: documents({ path: "notes/*.md", fields }) },
      authorize: () => true,
      logger: false,
    })
    cleanup.push(() => content.dispose())
    const collections = await createContentConsoleActions({ content }).collections({ user: { id: "ada" } } as never)
    expect(collections.find(entry => entry.name === "pages")).toMatchObject({ path: "docs/pages/**/*.md, packages/*/docs/**/*.md", paths: ["docs/pages/**/*.md", "packages/*/docs/**/*.md"] })
    expect(collections.find(entry => entry.name === "notes")).toMatchObject({ paths: ["notes/*.md"] })
  })
})

describe("content.resolve()", () => {
  async function setup() {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({
      workspace,
      collections: {
        posts: documents({ path: "blog/**/*.md", fields, url: "/blog/:id" }),
        pages: documents({ path: "pages/**/*.md", fields }),
      },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    const posts = content.collection("posts")
    const pages = content.collection("pages")
    for (const id of ["index", "about", "guides/index", "guides/start"]) await pages.save(id, { data: { title: id }, body: "" })
    await posts.save("hello", { data: { title: "Hello" }, body: "" })
    await content.publish()
    return { content, pages, posts }
  }

  it("maps an app path to its collection and id", async () => {
    const { content } = await setup()
    await expect(content.resolve("/blog/hello")).resolves.toEqual({ collection: "posts", id: "hello" })
    await expect(content.resolve("/about")).resolves.toEqual({ collection: "pages", id: "about" })
    await expect(content.resolve("/guides/start")).resolves.toEqual({ collection: "pages", id: "guides/start" })
  })

  it("maps the id without /index when a collection has no url, and ignores the query, the hash, and a trailing slash", async () => {
    const { content } = await setup()
    await expect(content.resolve("/")).resolves.toEqual({ collection: "pages", id: "index" })
    await expect(content.resolve("/guides")).resolves.toEqual({ collection: "pages", id: "guides/index" })
    await expect(content.resolve("/guides/?page=2#top")).resolves.toEqual({ collection: "pages", id: "guides/index" })
    await expect(content.resolve("blog/hello")).resolves.toEqual({ collection: "posts", id: "hello" })
  })

  it("returns null for a path that no document shows", async () => {
    const { content } = await setup()
    await expect(content.resolve("/missing")).resolves.toBeNull()
    await expect(content.resolve("/blog")).resolves.toBeNull()
    await expect(content.resolve("/hello")).resolves.toBeNull()
  })

  it("encodes reserved characters in default routes without merging distinct ids", async () => {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({ workspace, collections: { pages: documents({ path: "pages/**/*.md", fields }) }, logger: false })
    cleanup.push(() => content.dispose())
    const routes = [
      ["what", "/what"],
      ["what?now", "/what%3Fnow"],
      ["what#now", "/what%23now"],
      ["foo/bar", "/foo/bar"],
      ["foo%2Fbar", "/foo%252Fbar"],
      ["section?now/index", "/section%3Fnow"],
      ["section#now/index", "/section%23now"],
      ["café/100%", "/caf%C3%A9/100%25"],
    ] as const
    for (const [id] of routes) await content.collection("pages").save(id, { data: { title: id }, body: "" })
    await content.publish()
    for (const [id, path] of routes) {
      await expect(content.resolve(`${path}/?page=2#top`)).resolves.toEqual({ collection: "pages", id })
    }
  })

  it("looks in the published ref unless the draft is asked for", async () => {
    const { content, pages } = await setup()
    await pages.save("soon", { data: { title: "Soon" }, body: "" })
    await expect(content.resolve("/soon")).resolves.toBeNull()
    await expect(content.resolve("/soon", { ref: "draft" })).resolves.toEqual({ collection: "pages", id: "soon" })
  })

  it("lets the first collection win when two give one path", async () => {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({
      workspace,
      collections: {
        first: documents({ path: "a/*.md", fields, url: () => "/same" }),
        second: documents({ path: "b/*.md", fields, url: () => "/same" }),
      },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    await content.collection("second").save("x", { data: { title: "X" }, body: "" })
    await content.collection("first").save("y", { data: { title: "Y" }, body: "" })
    await content.publish()
    await expect(content.resolve("/same")).resolves.toEqual({ collection: "first", id: "y" })
  })

  it.each([
    { kind: "schema-invalid", text: "---\ntitle: 42\n---\n", ref: "published", readable: false },
    { kind: "schema-invalid", text: "---\ntitle: 42\n---\n", ref: "draft", readable: true },
    { kind: "malformed", text: "---\ntitle: [unclosed\n---\n", ref: "published", readable: false },
    { kind: "malformed", text: "---\ntitle: [unclosed\n---\n", ref: "draft", readable: false },
  ] as const)("matches read eligibility for $kind files on $ref with a url function, including collisions", async ({ text, ref, readable }) => {
    const workspace = await historyWorkspace(cleanup)
    // Existing files can predate Content's validation hook or the current field schema.
    await useWorkspace(workspace as never, { mode: "write" }).history.commit({
      ref,
      ifHead: null,
      changes: { put: { "a/same.md": text, "a/only.md": text, "b/same.md": "---\ntitle: Valid\n---\n" } },
    })
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const url = vi.fn(({ id }: { id: string }) => `/${id}`)
    const content = defineContent({
      workspace,
      collections: {
        first: documents({ path: "a/*.md", fields, url }),
        second: documents({ path: "b/*.md", fields }),
      },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    const first = content.collection("first")
    expect((await first.list({ ref })).items.map(item => item.id)).toEqual(readable ? ["only", "same"] : [])
    if (readable) await expect(first.get("same", { ref })).resolves.toMatchObject({ issues: expect.any(Array) })
    else await expect(first.get("same", { ref })).rejects.toMatchObject({ code: "CONTENT_INVALID" })
    // Reads call url too, so count only the calls made while building the resolve() index.
    url.mockClear()
    await expect(content.resolve("/same", { ref })).resolves.toEqual({ collection: readable ? "first" : "second", id: "same" })
    await expect(content.resolve("/only", { ref })).resolves.toEqual(readable ? { collection: "first", id: "only" } : null)
    expect(url).toHaveBeenCalledTimes(readable ? 2 : 0)
  })

  it("decodes the path and builds the routes once per revision", async () => {
    const workspace = await historyWorkspace(cleanup)
    const url = vi.fn(({ id }: { id: string }) => `/cafe/${id}`)
    const content = defineContent({ workspace, collections: { cafes: documents({ path: "cafes/*.md", fields, url }) }, logger: false })
    cleanup.push(() => content.dispose())
    await content.collection("cafes").save("café", { data: { title: "Café" }, body: "" })
    await content.publish()
    // Saves call url too, so count from the first resolve().
    const before = url.mock.calls.length
    await expect(content.resolve("/cafe/caf%C3%A9")).resolves.toEqual({ collection: "cafes", id: "café" })
    await expect(content.resolve("/cafe/caf%E9")).resolves.toBeNull()
    await expect(content.resolve("/cafe/café?x=1")).resolves.toEqual({ collection: "cafes", id: "café" })
    expect(url.mock.calls.length - before).toBe(1)
    // A new revision builds the map again.
    await content.collection("cafes").save("tea", { data: { title: "Tea" }, body: "" })
    await content.publish()
    const saved = url.mock.calls.length
    await expect(content.resolve("/cafe/tea")).resolves.toEqual({ collection: "cafes", id: "tea" })
    expect(url.mock.calls.length).toBeGreaterThan(saved)
  })

  it("skips a document whose url throws and warns once", async () => {
    let failing = false
    const workspace = await historyWorkspace(cleanup)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const content = defineContent({
      workspace,
      collections: { pages: documents({ path: "pages/*.md", fields, url: ({ id }) => { if (failing && id === "broken") throw new Error("no url"); return `/${id}` } }) },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    for (const id of ["broken", "fine", "other"]) await content.collection("pages").save(id, { data: { title: id }, body: "" })
    await content.publish()
    // Saves return the url, so it starts to throw only after them.
    failing = true
    await expect(content.resolve("/fine")).resolves.toEqual({ collection: "pages", id: "fine" })
    await expect(content.resolve("/broken")).resolves.toBeNull()
    await expect(content.resolve("/other")).resolves.toEqual({ collection: "pages", id: "other" })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain("failed for document \"broken\"")
  })

  /** A Workspace that counts the files each revision view reads, and a fresh Content runtime over it after `seed`. */
  async function counted(collections: () => Record<string, ReturnType<typeof documents>>, seed: (content: ReturnType<typeof defineContent>) => Promise<void>) {
    const reads: string[] = []
    const workspace = await historyWorkspace(cleanup, {
      wrap(store) {
        const open = store.history.open.bind(store.history)
        store.history = {
          ...store.history,
          open: async (id) => {
            const view = await open(id)
            return { ...view, revision: view.revision, list: view.list, stat: view.stat, readFile: ((path: string, ...rest: unknown[]) => {
              reads.push(path)
              return Reflect.apply(view.readFile, view, [path, ...rest])
            }) as typeof view.readFile }
          },
        }
      },
    })
    const writer = defineContent({ workspace, collections: collections(), logger: false })
    await seed(writer)
    writer.dispose()
    // A new runtime has no cached text, so every read below reaches the store.
    const content = defineContent({ workspace, collections: collections(), logger: false })
    cleanup.push(() => content.dispose())
    reads.length = 0
    return { content, reads }
  }

  it("reads no document when url is a pattern of :id alone", async () => {
    const { content, reads } = await counted(() => ({ posts: documents({ path: "blog/**/*.md", fields, url: "/blog/:id" }) }), async (writer) => {
      await writer.collection("posts").save("2026/hello", { data: { title: "Hello" }, body: "" })
      await writer.publish()
    })
    await expect(content.resolve("/blog/2026/hello")).resolves.toEqual({ collection: "posts", id: "2026/hello" })
    await expect(content.resolve("/2026/hello")).resolves.toBeNull()
    expect(reads.filter(path => path.startsWith("blog/"))).toEqual([])
  })

  it("reads the documents when url uses a field, with a pattern or a function", async () => {
    const withSlug = { title: z.string(), slug: z.string().optional() }
    const { content, reads } = await counted(() => ({
      posts: documents({ path: "posts/*.md", fields: withSlug, url: "/p/:slug" }),
      notes: documents({ path: "notes/*.md", fields: withSlug, url: ({ id, data }) => data.slug ? `/n/${data.slug}` : `/n/${id}` }),
    }), async (writer) => {
      await writer.collection("posts").save("first", { data: { title: "First", slug: "hello-world" }, body: "" })
      await writer.collection("notes").save("a", { data: { title: "A", slug: "short" }, body: "" })
      await writer.collection("notes").save("b", { data: { title: "B" }, body: "" })
      await writer.publish()
    })
    await expect(content.resolve("/p/hello-world")).resolves.toEqual({ collection: "posts", id: "first" })
    await expect(content.resolve("/p/first")).resolves.toBeNull()
    await expect(content.resolve("/n/short")).resolves.toEqual({ collection: "notes", id: "a" })
    await expect(content.resolve("/n/a")).resolves.toBeNull()
    await expect(content.resolve("/n/b")).resolves.toEqual({ collection: "notes", id: "b" })
    expect(reads.filter(path => path.endsWith(".md")).sort()).toEqual(["notes/a.md", "notes/b.md", "posts/first.md"])
  })

  it("does not resolve a document whose url is null", async () => {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({
      workspace,
      collections: {
        posts: documents({ path: "posts/*.md", fields: { title: z.string(), slug: z.string().optional() }, url: "/p/:slug" }),
        pages: documents({ path: "pages/*.md", fields, url: ({ id }) => id === "hidden" ? null : `/${id}` }),
      },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    await content.collection("posts").save("draft", { data: { title: "No slug" }, body: "" })
    for (const id of ["hidden", "shown"]) await content.collection("pages").save(id, { data: { title: id }, body: "" })
    await content.publish()
    await expect(content.resolve("/p")).resolves.toBeNull()
    await expect(content.resolve("/p/draft")).resolves.toBeNull()
    await expect(content.resolve("/hidden")).resolves.toBeNull()
    await expect(content.resolve("/shown")).resolves.toEqual({ collection: "pages", id: "shown" })
  })

  it("requires a string path", async () => {
    const { content } = await setup()
    // @ts-expect-error -- resolve takes a string.
    await expect(content.resolve(1)).rejects.toMatchObject({ code: "CONTENT_R0008" })
  })
})
