import { afterEach, describe, expect, it, vi } from "vitest"

import { normalizeWorkspaceSources } from "../src/source-config.ts"
import { createWorkspaceSourceView } from "../src/source-view.ts"
import { defineWorkspace, registerWorkspace, source } from "../src/index.ts"
import { resetWorkspaceRegistry } from "../src/registry.ts"
import { useRegisteredWorkspace } from "../src/registry.ts"
import { createMemoryWorkspaceStore } from "../src/stores/memory.ts"

afterEach(() => {
  resetWorkspaceRegistry()
  vi.restoreAllMocks()
})

describe("lazy sources", () => {
  it("exposes source-backed behavior through the source view seam", async () => {
    const definition = {
      name: "source-view",
      sources: {
        docs: source.custom({
          name: "docs",
          materialize: "lazy" as const,
          async getKeys() {
            return ["foo.md"]
          },
          async getItem(key: string) {
            return { key, path: key, content: "# Source view\n" }
          },
        }),
      },
    }
    const view = createWorkspaceSourceView(definition, createMemoryWorkspaceStore())

    await expect(view.list("docs")).resolves.toEqual([
      expect.objectContaining({ path: "docs/foo.md", type: "file" }),
    ])
    await expect(view.stat("docs/foo.md")).resolves.toMatchObject({ path: "docs/foo.md", type: "file" })
    await expect(view.readFile("docs/foo.md")).resolves.toBe("# Source view\n")
    await expect(view.writeFile("docs/foo.md", "nope")).rejects.toThrow("read-only")
    await expect(view.writeFile("generated/result.md", "ok")).resolves.toBeUndefined()
  })

  it("normalizes keyed source mounts and cache defaults", () => {
    const resolved = normalizeWorkspaceSources({
      docs: source.custom({
        name: "docs",
        materialize: "lazy",
        swr: 3600,
        async getKeys() {
          return []
        },
        async getItem(key) {
          return { key, path: key, content: "" }
        },
      }),
      skills: source.custom({
        name: "skills",
        async getKeys() {
          return []
        },
        async getItem(key) {
          return { key, path: key, content: "" }
        },
      }),
    })

    expect(resolved).toEqual([
      expect.objectContaining({
        key: "skills",
        mountPath: "skills",
        materialize: "build",
      }),
      expect.objectContaining({
        key: "docs",
        mountPath: "docs",
        materialize: "lazy",
        cache: { swr: true, maxAge: 3600 },
      }),
    ])
  })

  it("keeps lazy sources virtual until read and materializes only the requested file", async () => {
    const getItem = vi.fn(async (key: string) => ({ key, path: key, content: `# ${key}\n` }))
    registerWorkspace("lazy-docs", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: source.custom({
          name: "docs",
          materialize: "lazy",
          async getKeys() {
            return ["foo.md", "nested/bar.md"]
          },
          getItem,
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("lazy-docs")
    await workspace.sync()

    await expect(workspace.diff()).resolves.toMatchObject({ entries: [] })
    await expect(workspace.list("docs")).resolves.toEqual([
      expect.objectContaining({ path: "docs/foo.md", type: "file" }),
      expect.objectContaining({ path: "docs/nested", type: "directory" }),
    ])
    await expect(workspace.glob("docs/**/*.md")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/foo.md", type: "file" }),
      expect.objectContaining({ path: "docs/nested/bar.md", type: "file" }),
    ]))
    expect(getItem).not.toHaveBeenCalled()
    await expect(workspace.diff()).resolves.toMatchObject({ entries: [] })

    await expect(workspace.readFile("docs/foo.md")).resolves.toBe("# foo.md\n")
    expect(getItem).toHaveBeenCalledTimes(1)
    expect(getItem).toHaveBeenCalledWith("foo.md", expect.any(Object))
    await expect(workspace.diff()).resolves.toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ path: "docs/foo.md", type: "added" })]),
    })
  })

  it("keeps source-backed paths read-only while allowing normal store writes", async () => {
    registerWorkspace("lazy-writes", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: source.custom({
          name: "docs",
          materialize: "lazy",
          async getKeys() {
            return ["foo.md"]
          },
          async getItem(key) {
            return { key, path: key, content: "# Docs\n" }
          },
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("lazy-writes")
    await workspace.sync()

    await expect(workspace.writeFile("docs/foo.md", "nope")).rejects.toThrow("read-only")
    await expect(workspace.writeFile("artifacts/result.md", "ok")).resolves.toBeUndefined()
    await expect(workspace.readFile("artifacts/result.md")).resolves.toBe("ok")
  })

  it("prefers source-native search without materializing files", async () => {
    const getItem = vi.fn(async (key: string) => ({ key, path: key, content: "hello\n" }))
    const search = vi.fn(async () => [{
      path: "foo.md",
      line: 1,
      column: 1,
      text: "hello world",
    }])

    registerWorkspace("lazy-search", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: source.custom({
          name: "docs",
          materialize: "lazy",
          async getKeys() {
            return ["foo.md"]
          },
          getItem,
          search,
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("lazy-search")
    await workspace.sync()

    await expect(workspace.search({ pattern: "hello", paths: ["docs"] })).resolves.toEqual([
      { path: "docs/foo.md", line: 1, column: 1, text: "hello world" },
    ])
    expect(search).toHaveBeenCalledTimes(1)
    expect(getItem).not.toHaveBeenCalled()
    await expect(workspace.diff()).resolves.toMatchObject({ entries: [] })
  })

  it("falls back to source scanning for search without materializing files", async () => {
    const getItem = vi.fn(async (key: string) => ({
      key,
      path: key,
      content: key === "foo.md" ? "hello world\n" : "goodbye\n",
    }))

    registerWorkspace("lazy-fallback-search", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: source.custom({
          name: "docs",
          materialize: "lazy",
          async getKeys() {
            return ["foo.md", "bar.md"]
          },
          getItem,
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("lazy-fallback-search")
    await workspace.sync()

    await expect(workspace.search({ pattern: "hello", paths: ["docs"] })).resolves.toEqual([
      { path: "docs/foo.md", line: 1, column: 1, text: "hello world" },
    ])
    expect(getItem).toHaveBeenCalledTimes(2)
    await expect(workspace.diff()).resolves.toMatchObject({ entries: [] })

    await expect(workspace.readFile("docs/foo.md")).resolves.toBe("hello world\n")
    await expect(workspace.diff()).resolves.toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ path: "docs/foo.md", type: "added" })]),
    })
  })
})
