import { defineCollection } from "@vite-hub/source"
import { defineCollectionHandler } from "@vite-hub/source/server"
import { H3 } from "h3"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"

import { defineWorkspace, useWorkspace, workspaceFile } from "../src/index.ts"
import { resetWorkspaceRegistry } from "../src/core/registry.ts"
import { registerWorkspace } from "../src/test.ts"

import type { CollectionPage } from "@vite-hub/source"

const records = [
  { category: "guide", secret: "one", slug: "alpha", summary: "First guide", title: "Alpha" },
  { category: "reference", secret: "two", slug: "beta", summary: "API details", title: "Beta" },
  { category: "guide", secret: "three", slug: "gamma", summary: "Second guide", title: "Gamma" },
]

const articleSchema = v.object({ category: v.optional(v.string()), slug: v.string(), title: v.string() })

async function createWorkspace(name: string, content: unknown = records) {
  registerWorkspace(name, defineWorkspace({ store: { provider: "memory" } }))
  const workspace = useWorkspace(name, { mode: "write" })
  await workspace.fs.writeFile("data/items.json", JSON.stringify(content))
  return workspace
}

function articles(workspace: Parameters<typeof workspaceFile>[0]["workspace"], path = "data/items.json") {
  return defineCollection({
    source: workspaceFile({
      defaultLimit: 1,
      facets: ["category"],
      filters: ["category"],
      key: "slug",
      maxLimit: 2,
      path,
      schema: articleSchema,
      search: ["title", "summary"],
      sort: { field: "slug" },
      workspace,
    }),
    transform: ({ category, slug, title }) => ({ category, slug, title }),
  })
}

afterEach(() => {
  resetWorkspaceRegistry()
})

describe("workspaceFile()", () => {
  it("queries a JSON array stored in a Workspace file", async () => {
    await createWorkspace("collection-file")
    const collection = articles("collection-file")

    const first = await collection.page({ limit: 1, query: await collection.parseQuery({ category: "guide" }) })
    expect(first).toMatchObject({
      facets: { category: [{ count: 2, value: "guide" }] },
      items: [{ category: "guide", slug: "alpha", title: "Alpha" }],
      total: 2,
    })
    expect(first.items[0]).not.toHaveProperty("secret")

    const second = await collection.page({ cursor: first.nextCursor!, limit: 1, query: { category: ["guide"] } })
    expect(second).toMatchObject({ items: [{ slug: "gamma" }], nextCursor: null })
    await expect(collection.get?.("beta")).resolves.toEqual({ category: "reference", slug: "beta", title: "Beta" })
    await expect(collection.get?.("missing")).resolves.toBeNull()
  })

  it("makes older cursors stale after the file changes", async () => {
    const workspace = await createWorkspace("collection-file-stale")
    const collection = articles("collection-file-stale")
    const first = await collection.page({ query: {} })

    await workspace.fs.writeFile("data/items.json", JSON.stringify([...records, { category: "guide", slug: "zeta", title: "Zeta" }]))
    await expect(collection.page({ cursor: first.nextCursor!, query: {} })).rejects.toMatchObject({ reason: "stale" })
  })

  it("hashes the items when the Workspace stat has no digest", async () => {
    let content = JSON.stringify(records.slice(0, 2))
    const workspace = {
      fs: {
        readFile: async () => content,
        stat: async () => ({ path: "items.json", type: "file" as const }),
      },
    }
    // SAFETY: This fixture implements only the read methods workspaceFile() calls.
    const collection = articles(() => workspace as never, "items.json")
    const first = await collection.page({ query: {} })
    content = JSON.stringify(records.slice(1, 3))
    await expect(collection.page({ cursor: first.nextCursor!, query: {} })).rejects.toMatchObject({ reason: "stale" })
  })

  it("validates every item against the schema", async () => {
    await createWorkspace("collection-file-schema", [...records, { slug: 1 }])
    await expect(articles("collection-file-schema").page({ query: {} })).rejects.toThrow("item 3 does not match its schema")
  })

  it("types untyped files as records", async () => {
    await createWorkspace("collection-file-records")
    const collection = defineCollection({ source: workspaceFile({ path: "data/items.json", workspace: "collection-file-records" }) })
    const page = await collection.page({ query: {} })
    page.items satisfies Array<Record<string, unknown>>
    expect(page.total).toBe(3)
  })

  it("rejects missing files, directories, and non-array JSON", async () => {
    const workspace = await createWorkspace("collection-file-errors", { items: [] })
    await workspace.fs.writeFile("data/nested/file.json", "[]")

    await expect(articles("collection-file-errors").page({ query: {} })).rejects.toThrow("must contain a JSON array")
    await expect(articles("collection-file-errors", "data/nested").page({ query: {} })).rejects.toThrow("must be a file")
    await expect(articles("collection-file-errors", "data/missing.json").page({ query: {} })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" })
  })

  it("serves the generated Collection route contract", async () => {
    const workspace = await createWorkspace("collection-file-route")
    const app = new H3().get("/items", defineCollectionHandler(articles("collection-file-route")))

    const response = await app.request("/items?category=guide")
    const body = await response.json() as CollectionPage<Record<string, unknown>>
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ items: [{ slug: "alpha" }], total: 2 })

    expect((await app.request("/items?secret=one")).status).toBe(400)
    expect((await app.request("/items?empty=secret")).status).toBe(400)
    expect((await app.request("/items?limit=0")).status).toBe(400)
    expect((await app.request("/items?cursor=invalid")).status).toBe(400)
    expect((await app.request(`/items?search=guide&cursor=${encodeURIComponent(body.nextCursor!)}`)).status).toBe(409)

    await workspace.fs.writeFile("data/items.json", JSON.stringify([...records, { category: "guide", slug: "zeta", title: "Zeta" }]))
    expect((await app.request(`/items?category=guide&cursor=${encodeURIComponent(body.nextCursor!)}`)).status).toBe(409)
  })
})
