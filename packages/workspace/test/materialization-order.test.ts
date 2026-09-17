import { expect, it } from "vitest"

import { materializeWorkspaceSources } from "../src/sources/materialization.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

it.each([false, true])("returns Source statuses in resolution order with a failed Source: %s", async (fails) => {
  const executed: string[] = []
  const source = (key: string, path: string) => ({
    materialize: "startup" as const,
    mount: { path },
    async getKeys() {
      executed.push(key)
      if (fails && key === "deep") throw new Error("provider unavailable")
      return []
    },
    async getItem(key: string) { return { key, content: "" } },
  })
  const result = await materializeWorkspaceSources({
    name: "status-order",
    sources: {
      root: source("root", ""),
      deep: source("deep", "docs/deep"),
      zeta: source("zeta", "docs"),
      alpha: source("alpha", "docs"),
    },
  }, createMemoryWorkspaceStore())

  expect(executed).toEqual(["root", "zeta", "alpha", "deep"])
  expect(result.sources.map(status => [status.source, status.status])).toEqual([
    ["deep", fails ? "error" : "ready"],
    ["alpha", "ready"],
    ["zeta", "ready"],
    ["root", "ready"],
  ])
})

it.each([
  { change: "content", mount: "" },
  { change: "attributes", mount: "" },
  { change: "content", mount: "docs" },
  { change: "attributes", mount: "docs" },
])("restores cached startup precedence after overlapping $change writes at '$mount'", async ({ change, mount }) => {
  const store = createMemoryWorkspaceStore()
  const source = (priority: string, cache: false | { maxAge: number }) => ({
    cache,
    materialize: "startup" as const,
    mount: { path: priority === "high" ? mount : "" },
    async getKeys() { return [priority === "low" && mount ? `${mount}/shared.txt` : "shared.txt"] },
    async getMeta() { return priority === "high" ? { etag: "unchanged" } : undefined },
    async getItem(key: string) {
      return { key, content: change === "content" ? priority : "same", metadata: { priority } }
    },
  })
  const definition = { name: "cached-precedence", sources: { alpha: source("high", { maxAge: 3600 }), zeta: source("low", false) } }
  await materializeWorkspaceSources(definition, store)
  await materializeWorkspaceSources(definition, store)
  await expect(store.readFile(mount ? `${mount}/shared.txt` : "shared.txt")).resolves.toMatchObject({
    content: change === "content" ? "high" : "same", metadata: { priority: "high", source: "alpha" },
  })
})
