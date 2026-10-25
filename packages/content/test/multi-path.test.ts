import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

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

  it("rejects a route that is not a function", () => {
    // @ts-expect-error -- route takes a function.
    expect(errorOf(() => documents({ path: "posts/*.md", fields, route: "/blog" })).message).toContain("route must be a function")
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
        posts: documents({ path: "blog/**/*.md", fields, route: id => `/blog/${id}` }),
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

  it("strips /index by default and ignores the query, the hash, and a trailing slash", async () => {
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
        first: documents({ path: "a/*.md", fields, route: () => "/same" }),
        second: documents({ path: "b/*.md", fields, route: () => "/same" }),
      },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    await content.collection("second").save("x", { data: { title: "X" }, body: "" })
    await content.collection("first").save("y", { data: { title: "Y" }, body: "" })
    await content.publish()
    await expect(content.resolve("/same")).resolves.toEqual({ collection: "first", id: "y" })
  })

  it("decodes the path and builds the routes once per revision", async () => {
    const workspace = await historyWorkspace(cleanup)
    const route = vi.fn((id: string) => `/cafe/${id}`)
    const content = defineContent({ workspace, collections: { cafes: documents({ path: "cafes/*.md", fields, route }) }, logger: false })
    cleanup.push(() => content.dispose())
    await content.collection("cafes").save("café", { data: { title: "Café" }, body: "" })
    await content.publish()
    await expect(content.resolve("/cafe/caf%C3%A9")).resolves.toEqual({ collection: "cafes", id: "café" })
    await expect(content.resolve("/cafe/caf%E9")).resolves.toBeNull()
    await expect(content.resolve("/cafe/café?x=1")).resolves.toEqual({ collection: "cafes", id: "café" })
    expect(route).toHaveBeenCalledTimes(1)
    // A new revision builds the map again.
    await content.collection("cafes").save("tea", { data: { title: "Tea" }, body: "" })
    await content.publish()
    await expect(content.resolve("/cafe/tea")).resolves.toEqual({ collection: "cafes", id: "tea" })
    expect(route.mock.calls.length).toBeGreaterThan(1)
  })

  it("skips a document whose route throws and warns once", async () => {
    const workspace = await historyWorkspace(cleanup)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const content = defineContent({
      workspace,
      collections: { pages: documents({ path: "pages/*.md", fields, route: (id) => { if (id === "broken") throw new Error("no route"); return `/${id}` } }) },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    for (const id of ["broken", "fine", "other"]) await content.collection("pages").save(id, { data: { title: id }, body: "" })
    await content.publish()
    await expect(content.resolve("/fine")).resolves.toEqual({ collection: "pages", id: "fine" })
    await expect(content.resolve("/broken")).resolves.toBeNull()
    await expect(content.resolve("/other")).resolves.toEqual({ collection: "pages", id: "other" })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain("threw for document \"broken\"")
  })

  it("requires a string path", async () => {
    const { content } = await setup()
    // @ts-expect-error -- resolve takes a string.
    await expect(content.resolve(1)).rejects.toMatchObject({ code: "CONTENT_R0008" })
  })
})
