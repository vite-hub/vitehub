import { H3 } from "h3"
import { afterEach, describe, expect, it } from "vitest"

import { defineWorkspace, useWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry } from "../src/core/registry.ts"
import { defineWorkspaceCollectionHandler } from "../src/server.ts"
import { registerWorkspace } from "../src/test.ts"

import type { WorkspaceCollectionItem, WorkspaceCollectionPage } from "../src/collections.ts"

const records = [
  { category: "guide", secret: "one", slug: "alpha", summary: "First guide", title: "Alpha" },
  { category: "reference", secret: "two", slug: "beta", summary: "API details", title: "Beta" },
  { category: "guide", secret: "three", slug: "gamma", summary: "Second guide", title: "Gamma" },
]

async function createApp(name = "collection-handler") {
  registerWorkspace(name, defineWorkspace({ store: { provider: "memory" } }))
  const workspace = useWorkspace(name, { mode: "write" })
  await workspace.fs.writeFile("data/items.json", JSON.stringify(records))
  const app = new H3().get("/items", defineWorkspaceCollectionHandler({
    defaultLimit: 1,
    facets: ["category"],
    filters: ["category"],
    item: { key: "slug", select: ["slug", "summary"] },
    maxLimit: 2,
    path: "data/items.json",
    searchFields: ["title", "summary"],
    select: ["slug", "title", "category"],
    sort: { direction: "asc", field: "slug" },
    workspace: name,
  }))
  return { app, workspace }
}

afterEach(() => {
  resetWorkspaceRegistry()
})

describe("defineWorkspaceCollectionHandler", () => {
  it("serves bounded list pages and item detail as independent requests", async () => {
    const { app } = await createApp()
    const firstResponse = await app.request("/items?filter.category=guide&limit=1")
    const first = await firstResponse.json() as WorkspaceCollectionPage<Record<string, unknown>>

    expect(firstResponse.status).toBe(200)
    expect(first).toMatchObject({
      items: [{ category: "guide", slug: "alpha", title: "Alpha" }],
      total: 2,
    })
    expect(first.items[0]).not.toHaveProperty("summary")
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = await (await app.request(`/items?filter.category=guide&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).json() as WorkspaceCollectionPage<Record<string, unknown>>
    expect(second.items).toEqual([{ category: "guide", slug: "gamma", title: "Gamma" }])
    expect(second.nextCursor).toBeNull()

    const detail = await (await app.request("/items?value=beta")).json() as WorkspaceCollectionItem<Record<string, unknown>>
    expect(detail.item).toEqual({ slug: "beta", summary: "API details" })
    expect(detail.item).not.toHaveProperty("secret")
  })

  it("caps requested limits and returns facets over the filtered set", async () => {
    const { app } = await createApp("collection-handler-bounds")
    const response = await app.request("/items?limit=500&search=guide")
    const body = await response.json() as WorkspaceCollectionPage<Record<string, unknown>>

    expect(response.status).toBe(200)
    expect(body.items).toHaveLength(2)
    expect(body.total).toBe(2)
    expect(body.facets).toEqual({ category: [{ count: 2, value: "guide" }] })

    const facets = await (await app.request("/items?limit=1")).json() as WorkspaceCollectionPage<Record<string, unknown>>
    expect(facets.facets.category).toHaveLength(2)
  })

  it("preserves commas in filter values", async () => {
    const { app, workspace } = await createApp("collection-handler-commas")
    await workspace.fs.writeFile("data/items.json", JSON.stringify([
      ...records,
      { category: "Doe, Jane", slug: "comma", title: "Comma" },
    ]))

    const response = await app.request("/items?filter.category=Doe%2C%20Jane")
    const body = await response.json() as WorkspaceCollectionPage<Record<string, unknown>>
    expect(body.items).toEqual([{ category: "Doe, Jane", slug: "comma", title: "Comma" }])
  })

  it("filters empty values out of band from scalar values", async () => {
    const { app, workspace } = await createApp("collection-handler-empty")
    await workspace.fs.writeFile("data/items.json", JSON.stringify([
      ...records,
      { slug: "empty", title: "Empty" },
      { category: "__empty__", slug: "literal", title: "Literal" },
    ]))

    const empty = await (await app.request("/items?empty.category=true")).json() as WorkspaceCollectionPage<Record<string, unknown>>
    expect(empty.items).toEqual([{ slug: "empty", title: "Empty" }])
    const literal = await (await app.request("/items?filter.category=__empty__")).json() as WorkspaceCollectionPage<Record<string, unknown>>
    expect(literal.items).toEqual([{ category: "__empty__", slug: "literal", title: "Literal" }])
  })

  it("rejects disallowed query fields, filters, and limits", async () => {
    const { app } = await createApp("collection-handler-policy")

    expect((await app.request("/items?filter.secret=one")).status).toBe(400)
    expect((await app.request("/items?empty.secret=true")).status).toBe(400)
    expect((await app.request("/items?empty.category=false")).status).toBe(400)
    expect((await app.request("/items?sort=secret")).status).toBe(400)
    expect((await app.request("/items?limit=0")).status).toBe(400)
    expect((await app.request("/items?limit=1.5")).status).toBe(400)
  })

  it("maps malformed cursors to 400 and stale cursors to 409", async () => {
    const { app, workspace } = await createApp("collection-handler-cursors")
    expect((await app.request("/items?cursor=invalid")).status).toBe(400)

    const first = await (await app.request("/items?limit=1")).json() as WorkspaceCollectionPage<Record<string, unknown>>
    const mismatched = await app.request(`/items?limit=1&search=guide&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(mismatched.status).toBe(409)

    await workspace.fs.writeFile("data/items.json", JSON.stringify([...records, { category: "guide", slug: "zeta", title: "Zeta" }]))
    const stale = await app.request(`/items?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(stale.status).toBe(409)
  })

  it("maps missing collection files to 404 and invalid server data to 500", async () => {
    registerWorkspace("collection-handler-errors", defineWorkspace({ store: { provider: "memory" } }))
    const workspace = useWorkspace("collection-handler-errors", { mode: "write" })
    const missing = new H3().get("/items", defineWorkspaceCollectionHandler({
      path: "data/missing.json",
      workspace: "collection-handler-errors",
    }))
    expect((await missing.request("/items")).status).toBe(404)

    await workspace.fs.writeFile("data/items.json", "{}")
    const invalid = new H3().get("/items", defineWorkspaceCollectionHandler({
      path: "data/items.json",
      workspace: "collection-handler-errors",
    }))
    expect((await invalid.request("/items")).status).toBe(500)
  })
})
