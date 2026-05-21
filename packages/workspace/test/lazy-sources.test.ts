import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { normalizeWorkspaceSources } from "../src/source-config.ts"
import { createWorkspaceSourceView } from "../src/source-view.ts"
import { defineWorkspace, registerWorkspace, source } from "../src/index.ts"
import { resetWorkspaceRegistry } from "../src/registry.ts"
import { useRegisteredWorkspace } from "../src/registry.ts"
import { glob as globSource } from "../src/source.ts"
import { github as githubSource } from "../src/source.ts"
import { createMemoryWorkspaceStore } from "../src/stores/memory.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-lazy-sources-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  resetWorkspaceRegistry()
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("lazy sources", () => {
  it("exposes source-backed behavior through the source view seam", async () => {
    const definition = {
      name: "source-view",
      sources: {
        docs: source.custom({
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
        materialize: "lazy",
        cache: { maxAge: 3600 },
        async getKeys() {
          return []
        },
        async getItem(key) {
          return { key, path: key, content: "" }
        },
      }),
      skills: source.custom({
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
        cache: { maxAge: 3600 },
      }),
    ])
  })

  it("defaults cached GitHub sources to lazy repo basename mounts", () => {
    const resolved = normalizeWorkspaceSources({
      forecastingEngine: githubSource({
        cache: { maxAge: 3600 },
        repo: "onmax/forecasting-engine",
      }),
    })

    expect(resolved).toEqual([
      expect.objectContaining({
        key: "forecastingEngine",
        mountPath: "forecasting-engine",
        materialize: "lazy",
        cache: { maxAge: 3600 },
      }),
    ])
  })

  it("keeps explicit GitHub source mount and materialization options", () => {
    const resolved = normalizeWorkspaceSources({
      forecastingEngine: githubSource({
        cache: { maxAge: 3600 },
        materialize: "build",
        mount: "forecasting",
        repo: "onmax/forecasting-engine",
      }),
    })

    expect(resolved).toEqual([
      expect.objectContaining({
        mountPath: "forecasting",
        materialize: "build",
      }),
    ])
  })

  it("keeps lazy source roots virtual until first access then materializes the whole source", async () => {
    const getItem = vi.fn(async (key: string) => ({ key, path: key, content: `# ${key}\n` }))
    registerWorkspace("lazy-docs", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: source.custom({
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
    expect(getItem).not.toHaveBeenCalled()

    await expect(workspace.list("")).resolves.toEqual([
      expect.objectContaining({ path: "docs", type: "directory" }),
    ])

    await expect(workspace.glob("docs/**/*.md")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/foo.md", type: "file" }),
      expect.objectContaining({ path: "docs/nested/bar.md", type: "file" }),
    ]))
    expect(getItem).toHaveBeenCalledTimes(2)

    await expect(workspace.list("docs")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/foo.md", type: "file" }),
      expect.objectContaining({ path: "docs/nested", type: "directory" }),
    ]))
    expect(getItem).toHaveBeenCalledTimes(2)
    await expect(workspace.glob("docs/**/*.md")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/foo.md", type: "file" }),
      expect.objectContaining({ path: "docs/nested/bar.md", type: "file" }),
    ]))
    await expect(workspace.stat("docs/foo.md")).resolves.toMatchObject({ path: "docs/foo.md", type: "file" })
    await expect(workspace.exists("docs/nested/bar.md")).resolves.toBe(true)
    await expect(workspace.readFile("docs/foo.md")).resolves.toBe("# foo.md\n")
    expect(getItem).toHaveBeenCalledTimes(2)
    await expect(workspace.diff()).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "docs/foo.md", type: "added" }),
        expect.objectContaining({ path: "docs/nested/bar.md", type: "added" }),
      ]),
    })
  })

  it("uses a complete source snapshot after materialization", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(root, "docs", "README.md"), "# Docs\n")

    registerWorkspace("lazy-glob-live", defineWorkspace({
      rootDir: root,
      store: { provider: "memory" },
      sources: {
        docs: globSource({ cwd: "docs", include: "*.md", materialize: "lazy" }),
      },
    }))

    const workspace = await useRegisteredWorkspace("lazy-glob-live")
    await workspace.sync()

    await expect(workspace.list("docs")).resolves.toEqual([
      expect.objectContaining({ path: "docs/README.md", type: "file" }),
    ])

    await writeFile(join(root, "docs", "guide.md"), "# Guide\n")

    await expect(workspace.list("docs")).resolves.toEqual([
      expect.objectContaining({ path: "docs/README.md", type: "file" }),
    ])
  })

  it("keeps source-backed paths read-only while allowing normal store writes", async () => {
    registerWorkspace("lazy-writes", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: source.custom({
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

  it("materializes root-mounted lazy source paths before reads and keeps them read-only", async () => {
    registerWorkspace("lazy-root-files", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        rootFiles: source.custom({
          materialize: "lazy",
          mount: "",
          async getKeys() {
            return ["AGENTS.md"]
          },
          async getItem(key) {
            return { key, path: key, content: "# Instructions\n" }
          },
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("lazy-root-files")
    await workspace.sync()

    await expect(workspace.readFile("AGENTS.md")).resolves.toBe("# Instructions\n")
    await expect(workspace.writeFile("AGENTS.md", "nope")).rejects.toThrow("read-only")
    await expect(workspace.rm("AGENTS.md")).rejects.toThrow("read-only")
    await expect(workspace.mkdir("AGENTS.md")).rejects.toThrow("read-only")
    await expect(workspace.writeFile("generated/result.md", "ok")).resolves.toBeUndefined()
    await expect(workspace.readFile("generated/result.md")).resolves.toBe("ok")
  })

  it("rejects root-mounted lazy source mutations before materialization", async () => {
    registerWorkspace("lazy-root-prewrite", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        rootFiles: source.custom({
          materialize: "lazy",
          mount: "",
          async getKeys() {
            return ["AGENTS.md", "docs/guide.md"]
          },
          async getItem(key) {
            return { key, path: key, content: `# ${key}\n` }
          },
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("lazy-root-prewrite")
    await workspace.sync()

    await expect(workspace.writeFile("AGENTS.md", "shadow")).rejects.toThrow("read-only")
    await expect(workspace.rm("docs")).rejects.toThrow("read-only")
    await expect(workspace.mkdir("docs")).rejects.toThrow("read-only")
    await expect(workspace.writeFile("generated/result.md", "ok")).resolves.toBeUndefined()
  })

  it("materializes root-mounted lazy sources before returning existing store files", async () => {
    const store = createMemoryWorkspaceStore()
    await store.writeFile("AGENTS.md", { path: "AGENTS.md", content: "stale\n" })
    const view = createWorkspaceSourceView({
      name: "lazy-root-shadow",
      sources: {
        rootFiles: source.custom({
          materialize: "lazy",
          mount: "",
          async getKeys() {
            return ["AGENTS.md"]
          },
          async getItem(key) {
            return { key, path: key, content: "# Source\n" }
          },
        }),
      },
    }, store)

    await expect(view.readFile("AGENTS.md")).resolves.toBe("# Source\n")
  })

  it("removes stale root-mounted lazy source files on refresh", async () => {
    let keys = ["AGENTS.md", "nested/stale.md"]
    registerWorkspace("lazy-root-refresh", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        rootFiles: source.custom({
          materialize: "lazy",
          mount: "",
          async getKeys() {
            return keys
          },
          async getItem(key) {
            return { key, path: key, content: `# ${key}\n` }
          },
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("lazy-root-refresh")
    await workspace.sync()
    await workspace.mkdir("generated")
    await workspace.materializeSources?.()
    await expect(workspace.readFile("nested/stale.md")).resolves.toBe("# nested/stale.md\n")

    keys = ["AGENTS.md"]
    await workspace.materializeSources?.()

    await expect(workspace.exists("nested/stale.md")).resolves.toBe(false)
    await expect(workspace.exists("nested")).resolves.toBe(false)
    await expect(workspace.exists("generated")).resolves.toBe(true)
    await expect(workspace.readFile("AGENTS.md")).resolves.toBe("# AGENTS.md\n")
  })

  it("materializes root-mounted lazy sources for scoped paths", async () => {
    const getItem = vi.fn(async (key: string) => ({ key, path: key, content: `# ${key}\n` }))
    registerWorkspace("lazy-root-scoped", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        rootFiles: source.custom({
          materialize: "lazy",
          mount: "",
          async getKeys() {
            return ["docs/guide.md"]
          },
          getItem,
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("lazy-root-scoped")
    await workspace.sync()

    await expect(workspace.list("docs")).resolves.toEqual([
      expect.objectContaining({ path: "docs/guide.md", type: "file" }),
    ])
    expect(getItem).toHaveBeenCalledTimes(1)
  })

  it("searches materialized source snapshots", async () => {
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
      { path: "docs/foo.md", line: 1, column: 1, text: "hello" },
    ])
    expect(search).not.toHaveBeenCalled()
    expect(getItem).toHaveBeenCalledTimes(1)
    await expect(workspace.diff()).resolves.toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ path: "docs/foo.md", type: "added" })]),
    })
  })

  it("materializes source files before fallback search", async () => {
    const getItem = vi.fn(async (key: string) => ({
      key,
      path: key,
      content: key === "foo.md" ? "hello world\n" : "goodbye\n",
    }))

    registerWorkspace("lazy-fallback-search", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: source.custom({
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
    await expect(workspace.diff()).resolves.toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ path: "docs/foo.md", type: "added" })]),
    })
  })

  it("reuses cached materialized files within max age", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-05T12:00:00Z"))
    const getItem = vi.fn(async (key: string) => ({
      key,
      path: key,
      content: `version ${getItem.mock.calls.length}\n`,
    }))

    registerWorkspace("lazy-cache", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: source.custom({
          cache: { maxAge: 3600 },
          materialize: "lazy",
          async getKeys() {
            return ["foo.md"]
          },
          getItem,
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("lazy-cache")
    await workspace.sync()

    await expect(workspace.readFile("docs/foo.md")).resolves.toBe("version 1\n")
    vi.setSystemTime(new Date("2026-05-05T12:30:00Z"))
    await expect(workspace.readFile("docs/foo.md")).resolves.toBe("version 1\n")
    expect(getItem).toHaveBeenCalledTimes(1)
  })
})
