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
