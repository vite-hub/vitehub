import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { normalizeWorkspaceSources } from "../src/sources/config.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { custom, defineWorkspace, github, glob } from "../src/index.ts"
import { resetWorkspaceRegistry } from "../src/core/registry.ts"
import { registerWorkspace } from "../src/test.ts"
import { useRegisteredWorkspace } from "../src/core/registry.ts"
const globSource = glob
const githubSource = github
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"

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
        docs: custom({
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
      docs: custom({
        materialize: "lazy",
        cache: { maxAge: 3600 },
        scopes: ["support", "technical"],
        async getKeys() {
          return []
        },
        async getItem(key) {
          return { key, path: key, content: "" }
        },
      }),
      skills: custom({
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
        scopes: ["support", "technical"],
      }),
    ])
  })

  it("normalizes source binding scopes", () => {
    const resolved = normalizeWorkspaceSources({
      docs: {
        source: custom({
          async getKeys() {
            return []
          },
          async getItem(key) {
            return { key, path: key, content: "" }
          },
        }),
        scopes: ["support"],
      },
    })

    expect(resolved).toEqual([
      expect.objectContaining({
        key: "docs",
        scopes: ["support"],
      }),
    ])
  })

  it("materializes build sources when a path explicitly requests them", async () => {
    const view = createWorkspaceSourceView({
      name: "build-source-path",
      sources: {
        skills: custom({
          materialize: "build",
          mount: "skills",
          async getKeys() {
            return ["SKILL.md"]
          },
          async getItem(key) {
            return { key, path: key, content: "# Skills\n", mediaType: "text/markdown" }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.materializeSources()).resolves.toMatchObject({
      files: 0,
      sources: [],
    })

    await expect(view.materializeSources({ path: "skills" })).resolves.toMatchObject({
      files: 1,
      sources: [expect.objectContaining({ source: "skills", status: "ready" })],
    })
    await expect(view.readFile("skills/SKILL.md")).resolves.toBe("# Skills\n")
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
        docs: custom({
          materialize: "lazy",
          async getKeys() {
            return ["foo.md", "nested/bar.md"]
          },
          getItem,
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("lazy-docs")

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

  it("streams keyed source items while materializing", async () => {
    const order: string[] = []
    const store = createMemoryWorkspaceStore()
    const writeFile = store.writeFile.bind(store)
    store.writeFile = async (...args) => {
      order.push(`write:${args[0]}`)
      return await writeFile(...args)
    }
    const view = createWorkspaceSourceView({
      name: "lazy-streaming",
      sources: {
        docs: custom({
          materialize: "lazy",
          async getKeys() {
            return ["a.md", "b.md"]
          },
          async getItem(key) {
            order.push(`get:${key}`)
            return { key, path: key, content: `# ${key}\n` }
          },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })

    expect(order).toEqual([
      "get:a.md",
      "write:docs/a.md",
      "get:b.md",
      "write:docs/b.md",
    ])
  })

  it("lets sources read existing workspace files while materializing", async () => {
    let previousReport = ""
    const store = createMemoryWorkspaceStore()
    await store.writeFile("data/sync-report.json", {
      path: "data/sync-report.json",
      content: "{\"tasks\":1}",
    })
    const view = createWorkspaceSourceView({
      name: "source-context-files",
      sources: {
        mirror: custom({
          mount: {
            path: "generated",
            materialize: "lazy",
          },
          async getKeys(ctx) {
            expect(await ctx.workspaceFiles?.exists("data/sync-report.json")).toBe(true)
            expect(await ctx.workspaceFiles?.stat("data/sync-report.json")).toMatchObject({ path: "data/sync-report.json", type: "file" })
            previousReport = await ctx.workspaceFiles!.readFile("data/sync-report.json")
            return ["sync-report-copy.json"]
          },
          async getItem(key, ctx) {
            return {
              key,
              content: await ctx.workspaceFiles!.readFile("data/sync-report.json"),
            }
          },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["mirror"] })

    expect(previousReport).toBe("{\"tasks\":1}")
    await expect(view.readFile("generated/sync-report-copy.json")).resolves.toBe("{\"tasks\":1}")
  })

  it("materializes only requested lazy source paths", async () => {
    const getItem = vi.fn(async (key: string) => ({ key, path: key, content: `# ${key}\n` }))
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({
      name: "lazy-scoped-materialization",
      sources: {
        ingestion: custom({
          materialize: "lazy",
          mount: "ingestion",
          async getKeys() {
            return [
              "acme/models/orders.sql",
              "globex/models/orders.sql",
            ]
          },
          getItem,
        }),
      },
    }, store)

    await view.materializeSources({ path: "ingestion/acme", sources: ["ingestion"] })

    expect(getItem.mock.calls.map(call => call[0])).toEqual(["acme/models/orders.sql"])
    await expect(store.readFile("ingestion/acme/models/orders.sql")).resolves.toMatchObject({
      content: "# acme/models/orders.sql\n",
    })
    await expect(store.readFile("ingestion/globex/models/orders.sql")).resolves.toBeUndefined()
  })

  it("rejects keyed lazy source items that escape the source mount", async () => {
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({
      name: "lazy-unsafe-keyed-path",
      sources: {
        docs: custom({
          mount: { path: "docs", materialize: "lazy" },
          async getKeys() {
            return ["../outside.md"]
          },
          async getItem(key) {
            return { key, content: "# Outside\n" }
          },
        }),
      },
    }, store)

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({
        error: expect.stringContaining("Workspace path escapes the workspace root"),
        status: "error",
      })],
    })
    await expect(store.readFile("docs/../outside.md")).resolves.toBeUndefined()
  })

  it("rejects lazy source item paths that write reserved workspace roots", async () => {
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({
      name: "lazy-unsafe-item-path",
      sources: {
        root: custom({
          mount: { path: "", materialize: "lazy" },
          async getItems() {
            return [{
              key: "secret",
              path: ".vitehub/sources/secret.json",
              content: "{}",
            }]
          },
          async getKeys() {
            return []
          },
          async getItem(key) {
            return { key, content: "" }
          },
        }),
      },
    }, store)

    await expect(view.materializeSources({ sources: ["root"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({
        error: expect.stringContaining("Workspace source materialization item path is reserved"),
        status: "error",
      })],
    })
    await expect(store.readFile(".vitehub/sources/secret.json")).resolves.toBeUndefined()
  })

  it("streams source item content into stores that support streaming writes", async () => {
    const root = await createRoot()
    const store = createLocalWorkspaceStore(root)
    const writeFile = vi.spyOn(store, "writeFile")
    const writeFileStream = vi.spyOn(store, "writeFileStream")
    const view = createWorkspaceSourceView({
      name: "lazy-stream-content",
      sources: {
        docs: custom({
          materialize: "lazy",
          async getKeys() {
            return ["asset.bin"]
          },
          async getItem(key) {
            return {
              key,
              contentStream: new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array([0, 1, 2]))
                  controller.enqueue(new Uint8Array([3, 4]))
                  controller.close()
                },
              }),
              mediaType: "application/octet-stream",
            }
          },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })

    expect(writeFile).not.toHaveBeenCalled()
    expect(writeFileStream).toHaveBeenCalledTimes(1)
    await expect(view.readFile("docs/asset.bin", { encoding: "binary" })).resolves.toEqual(new Uint8Array([0, 1, 2, 3, 4]))
  })

  it("reuses keyed source items with unchanged upstream metadata", async () => {
    let ref = "one"
    const getItem = vi.fn(async (key: string) => ({ key, path: key, content: `# ${ref}\n` }))
    const view = createWorkspaceSourceView({
      name: "lazy-keyed-reuse",
      sources: {
        docs: custom({
          materialize: "lazy",
          async getKeys() {
            return ["a.md"]
          },
          getItem,
          async getMeta(key) {
            return { ref }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await view.materializeSources({ sources: ["docs"] })
    await view.materializeSources({ sources: ["docs"] })

    expect(getItem).toHaveBeenCalledTimes(1)
    await expect(view.readFile("docs/a.md")).resolves.toBe("# one\n")

    ref = "two"
    await view.materializeSources({ sources: ["docs"] })

    expect(getItem).toHaveBeenCalledTimes(2)
    await expect(view.readFile("docs/a.md")).resolves.toBe("# two\n")
  })

  it("resumes keyed source materialization after an interrupted refresh", async () => {
    let failSecond = true
    const getItem = vi.fn(async (key: string) => {
      if (key === "b.md" && failSecond) throw new Error("temporary source failure")
      return { key, path: key, content: `# ${key}\n` }
    })
    const view = createWorkspaceSourceView({
      name: "lazy-keyed-resume",
      sources: {
        docs: custom({
          materialize: "lazy",
          async getKeys() {
            return ["a.md", "b.md"]
          },
          getItem,
          async getMeta(key) {
            return { ref: key }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({ status: "error" })],
    })
    failSecond = false
    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({ status: "ready" })],
    })

    expect(getItem.mock.calls.map(call => call[0])).toEqual(["a.md", "b.md", "b.md"])
    await expect(view.readFile("docs/a.md")).resolves.toBe("# a.md\n")
    await expect(view.readFile("docs/b.md")).resolves.toBe("# b.md\n")
  })

  it("checks stale root source files sequentially while refreshing", async () => {
    let keys = ["a.bin", "b.bin", "c.bin"]
    let activeReads = 0
    let maxActiveReads = 0
    const store = createMemoryWorkspaceStore()
    const readFile = store.readFile.bind(store)
    store.readFile = async (...args) => {
      activeReads += 1
      maxActiveReads = Math.max(maxActiveReads, activeReads)
      try {
        await new Promise(resolve => setTimeout(resolve, 1))
        return await readFile(...args)
      }
      finally {
        activeReads -= 1
      }
    }
    const view = createWorkspaceSourceView({
      name: "lazy-root-sequential-cleanup",
      sources: {
        root: custom({
          materialize: "lazy",
          mount: "",
          async getKeys() {
            return keys
          },
          async getItem(key) {
            return { key, path: key, content: key }
          },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["root"] })
    keys = ["a.bin"]
    maxActiveReads = 0

    await view.materializeSources({ sources: ["root"] })

    expect(maxActiveReads).toBe(1)
    await expect(store.stat("b.bin")).resolves.toBeUndefined()
    await expect(store.stat("c.bin")).resolves.toBeUndefined()
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
        docs: custom({
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

    await expect(workspace.writeFile("docs/foo.md", "nope")).rejects.toThrow("read-only")
    await expect(workspace.writeFile("artifacts/result.md", "ok")).resolves.toBeUndefined()
    await expect(workspace.readFile("artifacts/result.md")).resolves.toBe("ok")
  })

  it("materializes root-mounted lazy source paths before reads and keeps them read-only", async () => {
    registerWorkspace("lazy-root-files", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        rootFiles: custom({
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
        rootFiles: custom({
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
        rootFiles: custom({
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
        rootFiles: custom({
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
        rootFiles: custom({
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
        docs: custom({
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
        docs: custom({
          materialize: "lazy",
          async getKeys() {
            return ["foo.md", "bar.md"]
          },
          getItem,
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("lazy-fallback-search")

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
        docs: custom({
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

    await expect(workspace.readFile("docs/foo.md")).resolves.toBe("version 1\n")
    vi.setSystemTime(new Date("2026-05-05T12:30:00Z"))
    await expect(workspace.readFile("docs/foo.md")).resolves.toBe("version 1\n")
    expect(getItem).toHaveBeenCalledTimes(1)
  })
})
