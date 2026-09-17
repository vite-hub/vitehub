import { describe, expect, it, vi } from "vitest"

import { custom } from "../src/index.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

describe.each([false, true])("root Source precedence with snapshot reuse=%s", (reuseStartupSnapshots) => {
  it.each(["readFile", "stat", "exists", "list"] as const)("uses the last startup Source when %s runs first", async (operation) => {
    const view = createWorkspaceSourceView({
      name: "root-startup-precedence",
      sources: {
        first: custom({ materialize: "startup", mount: "", files: [{ path: "shared.md", content: "first" }] }),
        last: custom({ materialize: "startup", mount: "", files: [{ path: "shared.md", content: "last" }] }),
      },
    }, createMemoryWorkspaceStore(), { reuseStartupSnapshots })

    await view[operation]("shared.md")
    await expect(view.readFile("shared.md")).resolves.toBe("last")
    await expect(view.stat("shared.md")).resolves.toMatchObject({ metadata: { source: "last" } })
    await expect(view.exists("shared.md")).resolves.toBe(true)
    await expect(view.readFile("shared.md")).resolves.toBe("last")
  })
})

it("keeps lazy root Sources selective when reading an existing startup file", async () => {
  const getKeys = vi.fn(async () => ["other.md"])
  const view = createWorkspaceSourceView({
    name: "root-startup-lazy-selectivity",
    sources: {
      startup: custom({ materialize: "startup", mount: "", files: [{ path: "shared.md", content: "startup" }] }),
      lazy: custom({ materialize: "lazy", mount: "", getKeys, async getItem(key) { return { key, content: "lazy" } } }),
    },
  }, createMemoryWorkspaceStore())

  await expect(view.readFile("shared.md")).resolves.toBe("startup")
  expect(getKeys).not.toHaveBeenCalled()
  await expect(view.readFile("other.md")).resolves.toBe("lazy")
  expect(getKeys).toHaveBeenCalledOnce()
})

it("restores root startup ownership when an unrelated lazy Source is present", async () => {
  const store = createMemoryWorkspaceStore()
  const getKeys = vi.fn(async () => ["other.md"])
  const first = createWorkspaceSourceView({
    name: "first",
    sources: {
      lazy: custom({ materialize: "lazy", mount: "", getKeys, async getItem(key) { return { key, content: "lazy" } } }),
      startup: custom({ materialize: "startup", mount: "", files: [{ path: "shared.md", content: "first" }] }),
    },
  }, store)
  const second = createWorkspaceSourceView({
    name: "second",
    sources: {
      startup: custom({ materialize: "startup", mount: "", files: [{ path: "shared.md", content: "second" }] }),
    },
  }, store)

  await expect(first.readFile("shared.md")).resolves.toBe("first")
  await expect(second.readFile("shared.md")).resolves.toBe("second")
  await expect(first.readFile("shared.md")).resolves.toBe("first")
  expect(getKeys).toHaveBeenCalledOnce()
  await expect(first.readFile("other.md")).resolves.toBe("lazy")
})
