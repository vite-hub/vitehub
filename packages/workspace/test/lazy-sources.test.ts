import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { normalizeWorkspaceSource, normalizeWorkspaceSources } from "../src/sources/config.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { markLiveWorkspaceSource } from "../src/sources/live.ts"
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
  it("indexes custom file lists without resolving other content", async () => {
    const guideContent = vi.fn(async (context: { workspace: string }) => {
      expect(context.workspace).toBe("custom-files")
      return "# Guide\n"
    })
    const referenceContent = vi.fn(async () => "# Reference\n")
    const source = custom({
      cache: { maxAge: 3600 },
      files: [
        { content: guideContent, path: "guides/start.md" },
        { content: referenceContent, path: "reference/api.md" },
      ],
      materialize: "lazy",
      mount: "docs",
      sync: { stale: "remove" },
      validate: "request",
    })

    // SAFETY: The custom Source fixture does not inspect its SourceContext argument.
    await expect(source.getKeys({} as never)).resolves.toEqual(["guides/start.md", "reference/api.md"])
    expect(guideContent).not.toHaveBeenCalled()
    expect(referenceContent).not.toHaveBeenCalled()
    expect(source).toMatchObject({
      cache: { maxAge: 3600 },
      materialize: "lazy",
      mount: "docs",
      sync: { stale: "remove" },
      validate: "request",
    })
    expect(custom({
      files: [],
      probeKeys: ["guides/start.md"],
    })).toMatchObject({ probeKeys: ["guides/start.md"] })

    const view = createWorkspaceSourceView({ name: "custom-files", sources: { docs: source } }, createMemoryWorkspaceStore())
    await expect(view.materializeSources({
      path: "docs/guides/start.md",
      sources: ["docs"],
    })).resolves.toMatchObject({
      files: 1,
      sources: [expect.objectContaining({ source: "docs", status: "ready" })],
    })
    await expect(view.readFile("docs/guides/start.md")).resolves.toBe("# Guide\n")
    await expect(view.stat("docs/guides/start.md")).resolves.toMatchObject({ mediaType: "text/markdown" })
    expect(guideContent).toHaveBeenCalledOnce()
    expect(referenceContent).not.toHaveBeenCalled()
    // SAFETY: The custom Source fixture does not inspect its SourceContext argument.
    await expect(source.getItem("missing.md", {} as never)).rejects.toThrow("Custom Workspace Source file does not exist")

    await expect(view.list("docs", { recursive: true })).resolves.toEqual([
      expect.objectContaining({ path: "docs/guides", type: "directory" }),
      expect.objectContaining({ path: "docs/guides/start.md", type: "file" }),
      expect.objectContaining({ path: "docs/reference", type: "directory" }),
      expect.objectContaining({ path: "docs/reference/api.md", type: "file" }),
    ])
  })

  it("rejects unsafe custom file-list paths", () => {
    expect(() => custom({
      files: [{ content: "private", path: "../private.md" }],
    })).toThrow("Workspace path escapes the workspace root")
  })

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

    await expect(view.list("", { exclude: ["docs"], recursive: true })).resolves.toEqual([])
    await expect(view.list("docs")).resolves.toEqual([
      expect.objectContaining({ path: "docs/foo.md", type: "file" }),
    ])
    await expect(view.stat("docs/foo.md")).resolves.toMatchObject({ path: "docs/foo.md", type: "file" })
    await expect(view.readFile("docs/foo.md")).resolves.toBe("# Source view\n")
    await expect(view.writeFile("docs/foo.md", "nope")).rejects.toThrow("read-only")
    await expect(view.writeFile("generated/result.md", "ok")).resolves.toBe("generated/result.md")
  })

  it("normalizes keyed source mounts and cache defaults", () => {
    const resolved = normalizeWorkspaceSources({
      docs: custom({
        materialize: "lazy",
        cache: { maxAge: 3600 },
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

  it("materializes trusted-host root-confined directory sources", async () => {
    const root = await createRoot()
    const sourceRoot = join(root, "source")
    await mkdir(join(sourceRoot, "review"), { recursive: true })
    await writeFile(join(sourceRoot, "review", "SKILL.md"), "# Review\n")
    const view = createWorkspaceSourceView({
      name: "trusted-host-directory",
      sourceRootDir: sourceRoot,
      sources: {
        review: globSource({
          cwd: "review",
          include: "**/*",
          mount: "review",
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.materializeSources({ path: "review" })).resolves.toMatchObject({
      files: 1,
      sources: [expect.objectContaining({ source: "review", status: "ready" })],
    })
    await expect(view.readFile("review/SKILL.md")).resolves.toBe("# Review\n")
  })

  it("defaults keyed cached GitHub sources to source-key mounts", () => {
    const resolved = normalizeWorkspaceSources({
      forecastingEngine: githubSource({
        cache: { maxAge: 3600 },
        repo: "onmax/forecasting-engine",
      }),
    })

    expect(resolved).toEqual([
      expect.objectContaining({
        key: "forecastingEngine",
        mountPath: "forecastingEngine",
        materialize: "lazy",
        cache: { maxAge: 3600 },
      }),
    ])
  })

  it("falls back to GitHub repo basename mounts for numeric source keys", () => {
    const resolved = normalizeWorkspaceSource("0", githubSource({
      repo: "onmax/forecasting-engine",
    }))

    expect(resolved).toEqual(expect.objectContaining({
      key: "0",
      mountPath: "forecasting-engine",
    }))
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

  it("reports source progress while materializing", async () => {
    const progress: unknown[] = []
    const view = createWorkspaceSourceView({
      name: "lazy-progress",
      sources: {
        docs: custom({
          materialize: "lazy",
          async getKeys() {
            return ["a.md"]
          },
          async getItem(key) {
            return { key, path: key, content: "# A\n" }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await view.materializeSources({
      onProgress(event) {
        progress.push(event)
      },
      path: "docs",
      sources: ["docs"],
    })

    expect(progress).toEqual([
      expect.objectContaining({
        mountPath: "docs",
        path: "docs",
        source: "docs",
        status: "started",
      }),
      expect.objectContaining({
        bytes: 4,
        files: 1,
        mountPath: "docs",
        path: "docs",
        source: "docs",
        status: "updating",
      }),
      expect.objectContaining({
        bytes: 4,
        durationMs: expect.any(Number),
        files: 1,
        mountPath: "docs",
        path: "docs",
        source: "docs",
        status: "completed",
      }),
    ])
  })

  it("resolves one immutable source revision for a materialization", async () => {
    const resolveRevision = vi.fn(async () => ({ id: "commit-123", immutable: true, ref: "main" }))
    const observedRevisions: unknown[] = []
    const view = createWorkspaceSourceView({
      name: "revision-pinned",
      sources: {
        docs: custom({
          materialize: "lazy",
          resolveRevision,
          async prepare(context) {
            observedRevisions.push(context.revision)
          },
          async getKeys(context) {
            observedRevisions.push(context.revision)
            return ["a.md"]
          },
          async getItem(key, context) {
            observedRevisions.push(context.revision)
            return { key, path: key, content: "# A\n" }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [{
        revision: { id: "commit-123", immutable: true, ref: "main" },
        source: "docs",
        status: "ready",
      }],
    })
    expect(resolveRevision).toHaveBeenCalledOnce()
    expect(observedRevisions).toEqual([
      { id: "commit-123", immutable: true, ref: "main" },
      { id: "commit-123", immutable: true, ref: "main" },
      { id: "commit-123", immutable: true, ref: "main" },
    ])
  })

  it("reports the pinned revision when materialization fails", async () => {
    const view = createWorkspaceSourceView({
      name: "failed-revision",
      sources: {
        docs: custom({
          materialize: "lazy",
          async resolveRevision() {
            return { id: "commit-broken", immutable: true, ref: "main" }
          },
          async getKeys() {
            return ["broken.md"]
          },
          async getItem() {
            throw new Error("origin failed")
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [{
        error: "origin failed",
        revision: { id: "commit-broken", immutable: true, ref: "main" },
        source: "docs",
        status: "error",
      }],
    })
  })

  it("materializes concrete source files without expanding the whole source", async () => {
    const getKeys = vi.fn(async () => {
      throw new Error("full source key expansion should not run")
    })
    const getItem = vi.fn(async (key: string) => ({ key, path: key, content: "# A\n" }))
    const getItems = vi.fn(async () => {
      throw new Error("full source expansion should not run")
    })
    const view = createWorkspaceSourceView({
      name: "lazy-direct-file",
      sources: {
        docs: custom({
          materialize: "lazy",
          getKeys,
          getItem,
          getItems,
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.materializeSources({ path: "docs/a.md", sources: ["docs"] })).resolves.toMatchObject({
      files: 1,
      sources: [expect.objectContaining({ source: "docs", status: "ready" })],
    })
    expect(getItem).toHaveBeenCalledWith("a.md", expect.any(Object))
    expect(getItem).toHaveBeenCalledTimes(1)
    expect(getKeys).not.toHaveBeenCalled()
    expect(getItems).not.toHaveBeenCalled()
    await expect(view.stat("docs/a.md")).resolves.toMatchObject({ path: "docs/a.md", type: "file" })
    await expect(view.exists("docs/a.md")).resolves.toBe(true)
    await expect(view.readFile("docs/a.md")).resolves.toBe("# A\n")
    expect(getItem).toHaveBeenCalledTimes(1)
    expect(getKeys).not.toHaveBeenCalled()
    expect(getItems).not.toHaveBeenCalled()
  })

  it("uses bulk item metadata without a second metadata request", async () => {
    const getMeta = vi.fn(async () => {
      throw new Error("bulk items already own their metadata")
    })
    const view = createWorkspaceSourceView({
      name: "bulk-item-metadata",
      sources: {
        docs: custom({
          materialize: "lazy",
          getItem: async key => ({ content: "# Ready\n", key }),
          getItems: async () => [{ content: "# Ready\n", key: "ready.md", metadata: { revision: "bulk" } }],
          getKeys: async () => ["ready.md"],
          getMeta,
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({ source: "docs", status: "ready" })],
    })
    await expect(view.stat("docs/ready.md")).resolves.toMatchObject({ metadata: { revision: "bulk" } })
    expect(getMeta).not.toHaveBeenCalled()
  })

  it("falls back to source metadata when a bulk item omits it", async () => {
    const getMeta = vi.fn(async () => ({ digest: "fallback" }))
    const view = createWorkspaceSourceView({
      name: "bulk-item-metadata-fallback",
      sources: {
        docs: custom({
          materialize: "lazy",
          getItem: async key => ({ content: "# Ready\n", key }),
          getItems: async () => [{ content: "# Ready\n", key: "ready.md" }],
          getKeys: async () => ["ready.md"],
          getMeta,
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({ source: "docs", status: "ready" })],
    })
    await expect(view.stat("docs/ready.md")).resolves.toMatchObject({ metadata: { digest: "fallback" } })
    expect(getMeta).toHaveBeenCalledOnce()
  })

  it("completes metadata for inferred bulk source items", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(root, "docs", "ready.md"), "# Ready\n")

    registerWorkspace("inferred-bulk-item-metadata", defineWorkspace({
      rootDir: root,
      store: { provider: "memory" },
      sources: {
        docs: globSource({ cwd: "docs", include: "*.md", materialize: "lazy" }),
      },
    }))

    const workspace = await useRegisteredWorkspace("inferred-bulk-item-metadata")
    await workspace.materializeSources?.({ sources: ["docs"] })

    await expect(workspace.stat("docs/ready.md")).resolves.toMatchObject({
      metadata: {
        digest: expect.any(String),
        mtime: expect.any(Number),
      },
    })
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
          async getMeta(_key) {
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

  it("checkpoints completed source items when materialization is canceled", async () => {
    const abort = new AbortController()
    let cancel = true
    const getItem = vi.fn(async (key: string) => {
      if (key === "b.md" && cancel) {
        cancel = false
        abort.abort(new DOMException("Canceled", "AbortError"))
        abort.signal.throwIfAborted()
      }
      return { key, path: key, content: `# ${key}\n` }
    })
    const view = createWorkspaceSourceView({
      name: "lazy-keyed-cancel",
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

    await expect(view.materializeSources({ abortSignal: abort.signal, sources: ["docs"] })).rejects.toThrow("Canceled")
    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({ status: "ready" })],
    })

    expect(getItem.mock.calls.map(call => call[0])).toEqual(["a.md", "b.md", "b.md"])
  })

  it("keeps a complete source ready when scoped materialization is canceled", async () => {
    const abort = new AbortController()
    let cancel = false
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({
      name: "lazy-scoped-cancel",
      sources: {
        docs: custom({
          materialize: "lazy",
          async getKeys() {
            return ["a.md", "b.md"]
          },
          async getItem(key) {
            if (key === "b.md" && cancel) {
              abort.abort(new DOMException("Canceled", "AbortError"))
              abort.signal.throwIfAborted()
            }
            return { key, path: key, content: `# ${key}\n` }
          },
          async getMeta(key) {
            return { ref: key }
          },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })
    cancel = true
    await expect(view.materializeSources({ abortSignal: abort.signal, path: "docs/b.md" })).rejects.toThrow("Canceled")

    await expect(store.getMeta?.("source:docs:snapshot")).resolves.toMatchObject({
      status: "ready",
      items: {
        "docs/a.md": expect.any(Object),
        "docs/b.md": expect.any(Object),
      },
    })
  })

  it("cancels materialization queued behind another view", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const materializing = new Promise<void>((resolve) => {
      started = resolve
    })
    const getItems = vi.fn(async () => {
      started()
      await blocked
      return [{ key: "a.md", content: "# A\n" }]
    })
    const definition = {
      name: "lazy-queued-cancel",
      sources: {
        docs: custom({
          materialize: "lazy" as const,
          getItems,
          async getItem(key) {
            return { key, content: "# A\n" }
          },
          async getKeys() {
            return ["a.md"]
          },
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    const first = createWorkspaceSourceView(definition, store)
    const second = createWorkspaceSourceView(definition, store)
    const active = first.materializeSources({ sources: ["docs"] })
    await materializing

    const abort = new AbortController()
    const queued = second.materializeSources({ abortSignal: abort.signal, sources: ["docs"] })
    abort.abort(new DOMException("Canceled", "AbortError"))
    await expect(queued).rejects.toThrow("Canceled")

    const third = createWorkspaceSourceView(definition, store)
    const later = third.materializeSources({ sources: ["docs"] })
    await Promise.resolve()
    expect(getItems).toHaveBeenCalledOnce()

    release()
    await active
    await later
    expect(getItems).toHaveBeenCalledTimes(2)
  })

  it("serializes path-scoped materialization only with matching Sources", async () => {
    let releaseAssets!: () => void
    const assetsBlocked = new Promise<void>((resolve) => {
      releaseAssets = resolve
    })
    let assetsStarted!: () => void
    const assetsMaterializing = new Promise<void>((resolve) => {
      assetsStarted = resolve
    })
    const docsItem = vi.fn(async (key: string) => ({ key, content: "# Guide\n" }))
    const definition = {
      name: "lazy-path-coordination",
      sources: {
        assets: custom({
          materialize: "lazy" as const,
          async getKeys() {
            assetsStarted()
            await assetsBlocked
            return ["logo.svg"]
          },
          async getItem(key) {
            return { key, content: "<svg />" }
          },
        }),
        docs: custom({
          materialize: "lazy" as const,
          async getKeys() {
            return ["guide.md"]
          },
          getItem: docsItem,
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    const first = createWorkspaceSourceView(definition, store)
    const second = createWorkspaceSourceView(definition, store)
    const assets = first.materializeSources({ path: "assets/logo.svg" })
    await assetsMaterializing

    await second.materializeSources({ sources: ["docs"] })
    expect(docsItem).toHaveBeenCalledOnce()

    releaseAssets()
    await assets
  })

  it("does not share pending materialization across Workspace Definitions", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const store = createMemoryWorkspaceStore()
    const first = createWorkspaceSourceView({
      name: "first-shared-store",
      sources: {
        docs: custom({
          materialize: "lazy",
          async getItem(key) {
            return { key, content: "# First\n" }
          },
          async getItems() {
            started()
            await blocked
            return [{ key: "first.md", content: "# First\n" }]
          },
          async getKeys() {
            return ["first.md"]
          },
        }),
      },
    }, store)
    const secondItems = vi.fn(async () => [{ key: "second.md", content: "# Second\n" }])
    const second = createWorkspaceSourceView({
      name: "second-shared-store",
      sources: {
        docs: custom({
          materialize: "lazy",
          async getItem(key) {
            return { key, content: "# Second\n" }
          },
          getItems: secondItems,
          async getKeys() {
            return ["second.md"]
          },
        }),
      },
    }, store)

    const firstMaterialization = first.materializeSources({ sources: ["docs"] })
    await firstStarted
    await second.materializeSources({ sources: ["docs"] })

    expect(secondItems).toHaveBeenCalledOnce()
    await expect(second.readFile("docs/second.md", { encoding: "utf8" })).resolves.toBe("# Second\n")
    release()
    await firstMaterialization
  })

  it("fully materializes a lazy Source after joining a scoped request", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const materializing = new Promise<void>((resolve) => {
      started = resolve
    })
    const getItem = vi.fn(async (key: string) => {
      if (key === "a.md") {
        started()
        await blocked
      }
      return { key, content: `# ${key}\n` }
    })
    const view = createWorkspaceSourceView({
      name: "lazy-scoped-join",
      sources: {
        docs: custom({
          materialize: "lazy",
          getItem,
          async getKeys() {
            return ["a.md", "b.md"]
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    const scoped = view.materializeSources({ path: "docs/a.md", sources: ["docs"] })
    await materializing
    const reading = view.readFile("docs/b.md", { encoding: "utf8" })
    release()

    await scoped
    await expect(reading).resolves.toBe("# b.md\n")
    expect(getItem.mock.calls.map(call => call[0])).toEqual(["a.md", "a.md", "b.md"])
  })

  it("persists complete source metadata at lifecycle boundaries", async () => {
    const store = createMemoryWorkspaceStore()
    const statuses: string[] = []
    const setMeta = store.setMeta!.bind(store)
    store.setMeta = async (key, value) => {
      if (key === "source:docs:snapshot" && value && Object.prototype.hasOwnProperty.call(value, "status")) {
        statuses.push(String(Reflect.get(Object(value), "status")))
      }
      await setMeta(key, value)
    }
    const view = createWorkspaceSourceView({
      name: "source-metadata-boundaries",
      sources: {
        docs: custom({
          materialize: "lazy",
          async getKeys() {
            return Array.from({ length: 100 }, (_, index) => `${index}.md`)
          },
          async getItem(key) {
            return { content: `# ${key}\n`, key, path: key }
          },
        }),
      },
    }, store)

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      files: 100,
      sources: [expect.objectContaining({ status: "ready" })],
    })

    expect(statuses).toEqual(["updating", "ready"])
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
    await expect(workspace.writeFile("artifacts/result.md", "ok")).resolves.toBe("artifacts/result.md")
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
    await expect(workspace.writeFile("generated/result.md", "ok")).resolves.toBe("generated/result.md")
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
    await expect(workspace.writeFile("generated/result.md", "ok")).resolves.toBe("generated/result.md")
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

    registerWorkspace("lazy-search", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: custom({
          materialize: "lazy",
          async getKeys() {
            return ["foo.md"]
          },
          getItem,
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("lazy-search")

    await expect(workspace.search({ pattern: "hello", paths: ["docs"] })).resolves.toEqual([
      { path: "docs/foo.md", line: 1, column: 1, text: "hello" },
    ])
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

  it("serves prepared startup live Sources from their snapshot", async () => {
    const getItem = vi.fn(async (key: string) => ({ key, content: `version ${getItem.mock.calls.length}\n` }))
    const source = markLiveWorkspaceSource(custom({
      materialize: "startup",
      async getKeys() {
        return ["status.txt"]
      },
      getItem,
    }), { "status.txt": "status.txt" })
    const definition = { name: "startup-live-snapshot", sources: { status: source } }
    const store = createMemoryWorkspaceStore()

    await createWorkspaceSourceView(definition, store).materializeSources({ sources: ["status"] })
    await expect(createWorkspaceSourceView(definition, store).readFile("status/status.txt")).resolves.toBe("version 1\n")
    expect(getItem).toHaveBeenCalledOnce()
  })

  it("bypasses provider preparation for completed startup snapshots", async () => {
    const prepare = vi.fn(async () => {})
    const source = custom({
      materialize: "startup",
      prepare,
      async getKeys() {
        return ["ready.md"]
      },
      async getItem(key) {
        return { key, content: "# Ready\n" }
      },
    })
    const definition = { name: "startup-prepared-snapshot", sources: { docs: source } }
    const store = createMemoryWorkspaceStore()

    await createWorkspaceSourceView(definition, store).materializeSources({ sources: ["docs"] })
    prepare.mockRejectedValue(new Error("provider unavailable"))

    await expect(createWorkspaceSourceView(definition, store).readFile("docs/ready.md")).resolves.toBe("# Ready\n")
    expect(prepare).toHaveBeenCalledOnce()
  })

  it("refreshes uncached lazy Sources across Workspace views", async () => {
    const getItem = vi.fn(async (key: string) => ({ key, content: `version ${getItem.mock.calls.length}\n` }))
    const definition = {
      name: "lazy-uncached-refresh",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy" as const,
          async getKeys() {
            return ["status.txt"]
          },
          getItem,
        }),
      },
    }
    const store = createMemoryWorkspaceStore()

    await createWorkspaceSourceView(definition, store).glob("docs/*.txt")
    await createWorkspaceSourceView(definition, store).glob("docs/*.txt")
    expect(getItem).toHaveBeenCalledTimes(2)
  })

  it("retries a lazy fallback after joined preparation is cancelled", async () => {
    let releaseStarted!: () => void
    const started = new Promise<void>((resolve) => { releaseStarted = resolve })
    const getKeys = vi.fn(async (context) => {
      if (getKeys.mock.calls.length === 1) {
        releaseStarted()
        await new Promise<never>((_resolve, reject) => {
          context.abortSignal?.addEventListener("abort", () => reject(context.abortSignal?.reason), { once: true })
        })
      }
      return ["ready.txt"]
    })
    const definition = {
      name: "lazy-cancelled-join",
      sources: {
        docs: custom({
          materialize: "startup" as const,
          getKeys,
          async getItem(key) {
            return { key, content: "ready\n" }
          },
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    const preparing = createWorkspaceSourceView(definition, store)
    const controller = new AbortController()
    const preparation = preparing.materializeSources({ abortSignal: controller.signal, sources: ["docs"] })
    await started

    const read = createWorkspaceSourceView(definition, store).readFile("docs/ready.txt")
    controller.abort(new Error("preparation stopped"))

    await expect(preparation).rejects.toThrow("preparation stopped")
    await expect(read).resolves.toBe("ready\n")
    expect(getKeys).toHaveBeenCalledTimes(2)
  })
})
