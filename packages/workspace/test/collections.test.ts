import { afterEach, describe, expect, it } from "vitest"

import { getWorkspaceCollectionItem, queryWorkspaceCollection, WorkspaceCollectionCursorError, workspaceCollectionEmpty } from "../src/collections.ts"
import { defineWorkspace, useWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry } from "../src/core/registry.ts"
import { registerWorkspace } from "../src/test.ts"

const records = [
  { authors: [{ name: "Ada" }], category: "guide", id: 1, slug: "alpha", summary: "First guide", title: "Alpha" },
  { authors: [{ name: "Grace" }], category: "reference", id: 2, slug: "beta", summary: "API details", title: "Beta" },
  { authors: [{ name: "Ada" }, { name: "Grace" }], category: "guide", id: 3, slug: "gamma", summary: "Second guide", title: "Gamma" },
  { authors: [], category: "note", id: 4, slug: "untagged", summary: "No author", title: "Untagged" },
]

async function createCollection(name: string, items: unknown[] = records) {
  registerWorkspace(name, defineWorkspace({ store: { provider: "memory" } }))
  const workspace = useWorkspace(name, { mode: "write" })
  await workspace.fs.writeFile("data/items.json", JSON.stringify(items))
  return workspace
}

afterEach(() => {
  resetWorkspaceRegistry()
})

describe("Workspace Collections", () => {
  it("filters, searches, sorts, facets, projects, and paginates explicit paths", async () => {
    await createCollection("collection-query")
    const query = {
      facets: ["category", "authors.name"],
      filters: { "authors.name": "Ada" },
      limit: 1,
      search: "a",
      searchFields: ["title"],
      select: ["slug", "title"],
      sort: { direction: "asc" as const, field: "slug" },
    }
    const first = await queryWorkspaceCollection<{ slug: string, title: string }>({
      path: "data/items.json",
      query,
      workspace: "collection-query",
    })

    expect(first.items).toEqual([{ slug: "alpha", title: "Alpha" }])
    expect(first.total).toBe(2)
    expect(first.facets).toEqual({
      "authors.name": [{ count: 2, value: "Ada" }, { count: 1, value: "Grace" }],
      "category": [{ count: 2, value: "guide" }],
    })
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = await queryWorkspaceCollection<{ slug: string, title: string }>({
      path: "data/items.json",
      query: { ...query, cursor: first.nextCursor! },
      workspace: "collection-query",
    })
    expect(second.items).toEqual([{ slug: "gamma", title: "Gamma" }])
    expect(second.nextCursor).toBeNull()
  })

  it("supports empty filters and bounds every page", async () => {
    await createCollection("collection-bounds")
    const empty = await queryWorkspaceCollection<{ slug: string }>({
      maxLimit: 2,
      path: "data/items.json",
      query: { filters: { "authors.name": workspaceCollectionEmpty }, limit: 500, select: ["slug"] },
      workspace: "collection-bounds",
    })

    expect(empty.items).toEqual([{ slug: "untagged" }])
    await expect(queryWorkspaceCollection({
      path: "data/items.json",
      query: { limit: 0 },
      workspace: "collection-bounds",
    })).rejects.toThrow("positive integer")

    const bounded = await queryWorkspaceCollection({
      maxLimit: 2,
      path: "data/items.json",
      query: { facets: ["category"], limit: 500 },
      workspace: "collection-bounds",
    })
    expect(bounded.items).toHaveLength(2)
    expect(bounded.facets.category).toHaveLength(2)
    expect(bounded.nextCursor).toEqual(expect.any(String))
  })

  it("returns item detail independently from collection pages", async () => {
    await createCollection("collection-item")

    await expect(getWorkspaceCollectionItem<{ slug: string, summary: string }>({
      path: "data/items.json",
      query: { key: "slug", select: ["slug", "summary"], value: "beta" },
      workspace: "collection-item",
    })).resolves.toMatchObject({ item: { slug: "beta", summary: "API details" } })
    await expect(getWorkspaceCollectionItem({
      path: "data/items.json",
      query: { key: "slug", value: "missing" },
      workspace: "collection-item",
    })).resolves.toMatchObject({ item: null })
  })

  it("sorts numeric fields numerically", async () => {
    await createCollection("collection-numeric-sort", [
      { rank: 10 },
      { rank: 2 },
      { rank: 1 },
    ])

    await expect(queryWorkspaceCollection({
      path: "data/items.json",
      query: { sort: { field: "rank" } },
      workspace: "collection-numeric-sort",
    })).resolves.toMatchObject({ items: [{ rank: 1 }, { rank: 2 }, { rank: 10 }] })
  })

  it("rejects malformed, query-mismatched, and content-stale cursors", async () => {
    const workspace = await createCollection("collection-cursors")
    const first = await queryWorkspaceCollection({
      path: "data/items.json",
      query: { limit: 1, sort: { field: "slug" } },
      workspace: "collection-cursors",
    })

    await expect(queryWorkspaceCollection({
      path: "data/items.json",
      query: { cursor: "not-a-cursor", limit: 1, sort: { field: "slug" } },
      workspace: "collection-cursors",
    })).rejects.toMatchObject({ reason: "malformed" })
    await expect(queryWorkspaceCollection({
      path: "data/items.json",
      query: { cursor: first.nextCursor!, limit: 1, search: "alpha", searchFields: ["title"], sort: { field: "slug" } },
      workspace: "collection-cursors",
    })).rejects.toMatchObject({ reason: "stale" })
    await expect(queryWorkspaceCollection({
      path: "data/items.json",
      query: { cursor: first.nextCursor!, limit: 2, sort: { field: "slug" } },
      workspace: "collection-cursors",
    })).rejects.toMatchObject({ reason: "stale" })

    await workspace.fs.writeFile("data/items.json", JSON.stringify([...records, { id: 5, slug: "zeta", title: "Zeta" }]))
    await expect(queryWorkspaceCollection({
      path: "data/items.json",
      query: { cursor: first.nextCursor!, limit: 1, sort: { field: "slug" } },
      workspace: "collection-cursors",
    })).rejects.toBeInstanceOf(WorkspaceCollectionCursorError)
  })

  it("accepts cursors across semantically equivalent query forms", async () => {
    await createCollection("collection-normalized-cursors")
    const first = await queryWorkspaceCollection({
      path: "data/items.json",
      query: { filters: { category: "Guide" }, limit: 1, sort: { field: "slug" } },
      workspace: "collection-normalized-cursors",
    })

    await expect(queryWorkspaceCollection({
      path: "data/items.json",
      query: { cursor: first.nextCursor!, filters: { category: "guide" }, limit: 1, sort: { direction: "asc", field: "slug" } },
      workspace: "collection-normalized-cursors",
    })).resolves.toMatchObject({ items: [{ slug: "gamma" }] })
  })

  it("distinguishes empty operators from literal filter values in cursors", async () => {
    await createCollection("collection-empty-cursors", [
      { category: "empty", slug: "literal" },
      { category: "empty", slug: "literal-2" },
      { slug: "missing" },
    ])
    const first = await queryWorkspaceCollection({
      path: "data/items.json",
      query: { filters: { category: "empty" }, limit: 1 },
      workspace: "collection-empty-cursors",
    })

    await expect(queryWorkspaceCollection({
      path: "data/items.json",
      query: { cursor: first.nextCursor!, filters: { category: workspaceCollectionEmpty }, limit: 1 },
      workspace: "collection-empty-cursors",
    })).rejects.toMatchObject({ reason: "stale" })
  })

  it("computes a content digest when Workspace stat has none", async () => {
    let content = JSON.stringify(records.slice(0, 2))
    const workspace = {
      fs: {
        readFile: async () => content,
        stat: async () => ({ path: "items.json", type: "file" as const }),
      },
      tools: {},
    }
    const first = await queryWorkspaceCollection({
      path: "items.json",
      query: { limit: 1 },
      workspace: workspace as never,
    })
    content = JSON.stringify(records.slice(1, 3))

    await expect(queryWorkspaceCollection({
      path: "items.json",
      query: { cursor: first.nextCursor!, limit: 1 },
      workspace: workspace as never,
    })).rejects.toMatchObject({ reason: "stale" })
  })
})
