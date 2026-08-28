import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { normalizeWorkspaceSource, normalizeWorkspaceSources } from "../src/sources/config.ts"
import { markLiveWorkspaceSource } from "../src/sources/live.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { custom, defineWorkspace, github, glob, mcpResources } from "../src/index.ts"
import { resetWorkspaceRegistry } from "../src/core/registry.ts"
import { registerWorkspace } from "../src/test.ts"
import { useRegisteredWorkspace } from "../src/core/registry.ts"
const globSource = glob
const githubSource = github
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import type { SourceContext, WorkspaceDefinition, WorkspaceMaterializeSourcesProgressEvent } from "../src/core/types.ts"

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
    const definition: WorkspaceDefinition = {
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
        counts: { added: 1, removed: 0, unchanged: 0, updated: 0 },
        files: 1,
        mountPath: "docs",
        path: "docs",
        source: "docs",
        status: "updating",
      }),
      expect.objectContaining({
        bytes: 4,
        cacheStatus: "disabled",
        counts: { added: 1, removed: 0, unchanged: 0, updated: 0 },
        durationMs: expect.any(Number),
        files: 1,
        mountPath: "docs",
        path: "docs",
        source: "docs",
        status: "completed",
      }),
    ])
  })

  it("reports failures during source fingerprinting", async () => {
    const progress: unknown[] = []
    const view = createWorkspaceSourceView({
      name: "lazy-fingerprint-failure",
      sources: {
        docs: custom({
          fingerprint: {
            toJSON() {
              throw new Error("fingerprint unavailable")
            },
          },
          materialize: "lazy",
          async getItem(key) {
            return { content: "", key }
          },
          async getKeys() {
            return []
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    const result = await view.materializeSources({
      onProgress(event) {
        progress.push(event)
      },
      sources: ["docs"],
    })

    expect(progress).toEqual([
      expect.objectContaining({ source: "docs", status: "started" }),
      expect.objectContaining({ error: "fingerprint unavailable", source: "docs", status: "failed" }),
    ])
    expect(result.sources).toEqual([
      expect.objectContaining({ error: "fingerprint unavailable", source: "docs", status: "error" }),
    ])
  })

  it("rethrows cancellation during source snapshot setup", async () => {
    const abort = new AbortController()
    const store = createMemoryWorkspaceStore()
    store.getMeta = vi.fn(async () => {
      abort.abort(new DOMException("Canceled", "AbortError"))
      abort.signal.throwIfAborted()
    })
    const view = createWorkspaceSourceView({
      name: "snapshot-cancellation",
      sources: {
        docs: custom({
          materialize: "lazy",
          async getKeys() {
            return []
          },
          async getItem(key) {
            return { content: "", key }
          },
        }),
      },
    }, store)

    await expect(view.materializeSources({ abortSignal: abort.signal, sources: ["docs"] })).rejects.toThrow("Canceled")
  })

  it("rejects canceled materializations while they wait in the queue", async () => {
    let releaseActive!: () => void
    let markActiveStarted!: () => void
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve
    })
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve
    })
    const getKeys = vi.fn(async () => {
      if (getKeys.mock.calls.length === 1) {
        markActiveStarted()
        await activeGate
      }
      return []
    })
    const view = createWorkspaceSourceView({
      name: "queued-materialization-cancellation",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          getKeys,
          async getItem(key) {
            return { content: "", key }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    const active = view.materializeSources({ sources: ["docs"] })
    await activeStarted
    const abort = new AbortController()
    const queued = view.materializeSources({ abortSignal: abort.signal, sources: ["docs"] })
    abort.abort(new DOMException("Canceled while queued", "AbortError"))

    await expect(queued).rejects.toThrow("Canceled while queued")
    expect(getKeys).toHaveBeenCalledOnce()
    releaseActive()
    await expect(active).resolves.toMatchObject({ sources: [expect.objectContaining({ status: "ready" })] })
    expect(getKeys).toHaveBeenCalledOnce()
  })

  it("reports cache disposition and opt-in file deltas", async () => {
    let files = new Map([
      ["a.md", { content: "# A\n", digest: "a-1" }],
      ["b.md", { content: "# B\n", digest: "b-1" }],
    ])
    const getItem = vi.fn(async (key: string) => {
      const file = files.get(key)
      if (!file) throw new Error(`Missing ${key}`)
      return { key, path: key, content: file.content, metadata: { digest: file.digest } }
    })
    const view = createWorkspaceSourceView({
      name: "materialization-deltas",
      sources: {
        docs: custom({
          cache: { maxAge: -1 },
          materialize: "lazy",
          name: "fixture",
          async getKeys() {
            return [...files.keys()]
          },
          getItem,
          async getMeta(key) {
            const file = files.get(key)
            return file ? { digest: file.digest } : undefined
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.materializeSources({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      sources: [{
        cacheStatus: "miss",
        counts: { added: 2, removed: 0, unchanged: 0, updated: 0 },
        paths: [
          { path: "docs/a.md", status: "added" },
          { path: "docs/b.md", status: "added" },
        ],
        provider: "fixture",
      }],
    })

    files = new Map([
      ["a.md", { content: "# A\n", digest: "a-1" }],
      ["c.md", { content: "# C\n", digest: "c-1" }],
    ])
    const updated = await view.materializeSources({ details: "paths", sources: ["docs"] })
    expect(updated.sources[0]).toMatchObject({
      cacheStatus: "miss",
      counts: { added: 1, removed: 1, unchanged: 1, updated: 0 },
      paths: expect.arrayContaining([
        { path: "docs/a.md", status: "unchanged" },
        { path: "docs/b.md", status: "removed" },
        { path: "docs/c.md", status: "added" },
      ]),
    })
    expect(getItem).toHaveBeenCalledTimes(3)
  })

  it("returns aggregate cache hits without exposing paths by default", async () => {
    const getItem = vi.fn(async (key: string) => ({ key, path: key, content: "# Cached\n" }))
    const view = createWorkspaceSourceView({
      name: "materialization-cache",
      sources: {
        docs: custom({
          cache: { maxAge: 3600 },
          materialize: "lazy",
          async getKeys() {
            return ["cached.md"]
          },
          getItem,
        }),
      },
    }, createMemoryWorkspaceStore())

    const materialized = await view.materializeSources({ sources: ["docs"] })
    const cached = await view.materializeSources({ sources: ["docs"] })

    expect(materialized.sources[0]).not.toHaveProperty("cacheMaxAge")
    expect(materialized.sources[0]).not.toHaveProperty("configHash")
    expect(materialized.sources[0]).not.toHaveProperty("items")
    expect(materialized.sources[0]).not.toHaveProperty("paths")
    expect(cached.sources[0]).toMatchObject({
      cacheStatus: "hit",
      counts: { added: 0, removed: 0, unchanged: 1, updated: 0 },
    })
    expect(cached.sources[0]).not.toHaveProperty("paths")
    expect(getItem).toHaveBeenCalledOnce()
  })

  it("honors cancellation while resolving a cached source snapshot", async () => {
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({
      name: "materialization-cache-cancellation",
      sources: {
        docs: custom({
          cache: { maxAge: 3600 },
          materialize: "lazy",
          async getKeys() {
            return ["cached.md"]
          },
          async getItem(key) {
            return { key, content: "# Cached\n" }
          },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })
    const getMeta = store.getMeta!.bind(store)
    let releaseSnapshot!: () => void
    let observeSnapshot!: () => void
    const snapshotPending = new Promise<void>((resolve) => {
      releaseSnapshot = resolve
    })
    const snapshotObserved = new Promise<void>((resolve) => {
      observeSnapshot = resolve
    })
    store.getMeta = async (key) => {
      const value = await getMeta(key)
      if (key === "source:docs:snapshot") {
        observeSnapshot()
        await snapshotPending
      }
      return value
    }
    const abort = new AbortController()
    const materialization = view.materializeSources({ abortSignal: abort.signal, sources: ["docs"] })
    await snapshotObserved
    abort.abort(new Error("cancel cached materialization"))
    releaseSnapshot()

    await expect(materialization).rejects.toThrow("cancel cached materialization")
  })

  it("does not expose materialization cancellation to concurrent Source preparation", async () => {
    let releaseMaterialization!: () => void
    let observeMaterialization!: () => void
    const materializationPending = new Promise<void>((resolve) => {
      releaseMaterialization = resolve
    })
    const materializationObserved = new Promise<void>((resolve) => {
      observeMaterialization = resolve
    })
    const prepare = vi.fn()
    const source = custom({
      cache: false,
      materialize: "lazy",
      prepare,
      async getKeys(context) {
        if (context.abortSignal) {
          observeMaterialization()
          await materializationPending
          context.abortSignal.throwIfAborted()
        }
        return ["guide.md"]
      },
      async getItem(key) {
        return { key, path: key, content: "# Guide\n" }
      },
    })
    const view = createWorkspaceSourceView({
      name: "materialization-cancellation-isolation",
      sources: { docs: source },
    }, createMemoryWorkspaceStore())
    const abort = new AbortController()

    const materialization = view.materializeSources({ abortSignal: abort.signal, sources: ["docs"] })
    await materializationObserved
    const listing = view.list("docs", { recursive: true })
    abort.abort(new DOMException("Canceled", "AbortError"))
    releaseMaterialization()

    await expect(materialization).rejects.toThrow("Canceled")
    await expect(listing).resolves.toEqual([
      expect.objectContaining({ path: "docs/guide.md", type: "file" }),
    ])
    expect(prepare).toHaveBeenCalledOnce()
  })

  it("does not expose later materialization cancellation to active Source preparation", async () => {
    let releasePreparation!: () => void
    let observePreparation!: () => void
    const preparationPending = new Promise<void>((resolve) => {
      releasePreparation = resolve
    })
    const preparationObserved = new Promise<void>((resolve) => {
      observePreparation = resolve
    })
    const prepare = vi.fn(async () => {
      observePreparation()
      await preparationPending
    })
    const source = custom({
      cache: false,
      materialize: "lazy",
      prepare,
      async getKeys() {
        return ["guide.md"]
      },
      async getItem(key) {
        return { key, path: key, content: "# Guide\n" }
      },
    })
    const view = createWorkspaceSourceView({
      name: "preparation-cancellation-isolation",
      sources: { docs: source },
    }, createMemoryWorkspaceStore())
    const abort = new AbortController()

    const listing = view.list("docs", { recursive: true })
    await preparationObserved
    const materialization = view.materializeSources({ abortSignal: abort.signal, sources: ["docs"] })
    abort.abort(new DOMException("Canceled", "AbortError"))
    releasePreparation()

    await expect(materialization).rejects.toThrow("Canceled")
    await expect(listing).resolves.toEqual([
      expect.objectContaining({ path: "docs/guide.md", type: "file" }),
    ])
    expect(prepare).toHaveBeenCalledOnce()
  })

  it("retries a failed concurrent preparation before materializing the Source", async () => {
    let releasePreparation!: () => void
    let observePreparation!: () => void
    const preparationPending = new Promise<void>((resolve) => {
      releasePreparation = resolve
    })
    const preparationObserved = new Promise<void>((resolve) => {
      observePreparation = resolve
    })
    const clients = new WeakMap<object, { keys: string[] }>()
    let attempts = 0
    const prepare = vi.fn(async (context: SourceContext) => {
      attempts++
      if (attempts === 1) {
        observePreparation()
        await preparationPending
        throw new Error("temporary preparation failure")
      }
      clients.set(context, { keys: ["guide.md"] })
    })
    const view = createWorkspaceSourceView({
      name: "concurrent-preparation-retry",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          prepare,
          async getKeys(context: SourceContext) {
            return clients.get(context)?.keys || []
          },
          async getItem(key) {
            return { key, path: key, content: "# Guide\n" }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    const listing = view.list("docs", { recursive: true })
    await preparationObserved
    const materialization = view.materializeSources({ sources: ["docs"] })
    releasePreparation()

    await expect(listing).rejects.toThrow("temporary preparation failure")
    await expect(materialization).resolves.toMatchObject({
      sources: [{ files: 1, status: "ready" }],
    })
    await expect(view.readFile("docs/guide.md", { encoding: "utf8" })).resolves.toBe("# Guide\n")
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it("prepares a live Source after a cache hit in a fresh view", async () => {
    const store = createMemoryWorkspaceStore()
    const client = {
      async listResources() {
        return { resources: [{ name: "Guide", uri: "resource://docs/guide" }] }
      },
      async readResource() {
        return { contents: [{ text: "# Guide\n", uri: "resource://docs/guide" }] }
      },
    }
    const definition = () => ({
      name: "materialization-live-cache",
      sources: {
        docs: mcpResources({ cache: { maxAge: 3600 }, materialize: "lazy", mount: "docs", server: client }),
      },
    })

    await createWorkspaceSourceView(definition(), store).materializeSources({ sources: ["docs"] })
    const freshView = createWorkspaceSourceView(definition(), store)
    await expect(freshView.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [{ cacheStatus: "hit", status: "ready" }],
    })
    await expect(freshView.list("docs", { recursive: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/docs/guide", type: "file" }),
    ]))
  })

  it("prepares the persistent live Source context after explicit materialization", async () => {
    const revision = { id: "commit-123", immutable: true, ref: "main" }
    const resolveRevision = vi.fn(async () => revision)
    const source = custom({
      cache: false,
      materialize: "lazy",
      resolveRevision,
      async getKeys() {
        return ["guide.md"]
      },
      async getItem(key, context) {
        return { key, path: key, content: context.revision?.id || "missing revision" }
      },
    })
    markLiveWorkspaceSource(source, { "docs/guide.md": "guide.md" })
    const view = createWorkspaceSourceView({ name: "materialization-live-revision", sources: { docs: source } }, createMemoryWorkspaceStore())

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [{ revision, status: "ready" }],
    })
    await expect(view.readFile("docs/guide.md")).resolves.toBe("commit-123")
    expect(resolveRevision).toHaveBeenCalledOnce()
  })

  it("preserves the resolved revision in persistent non-live Source contexts", async () => {
    const revision = { id: "commit-123", immutable: true, ref: "main" }
    const resolveRevision = vi.fn(async () => revision)
    const source = custom({
      cache: false,
      materialize: "lazy",
      resolveRevision,
      async getKeys(context) {
        return context.revision?.id === revision.id ? ["current.md"] : ["stale.md"]
      },
      async getItem(key) {
        return { key, path: key, content: "# Current\n" }
      },
    })
    const view = createWorkspaceSourceView({ name: "materialization-persistent-revision", sources: { docs: source } }, createMemoryWorkspaceStore())

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [{ revision, status: "ready" }],
    })
    await expect(view.exists("docs/stale.md")).resolves.toBe(false)
    await expect(view.stat("docs/stale.md")).rejects.toThrow("Workspace path does not exist")
    expect(resolveRevision).toHaveBeenCalledOnce()
  })

  it("resolves a new immutable revision for each materialization", async () => {
    const revisions = [
      { id: "commit-123", immutable: true, ref: "main" },
      { id: "commit-456", immutable: true, ref: "main" },
    ]
    const resolveRevision = vi.fn(async () => revisions.shift())
    const source = custom({
      cache: false,
      materialize: "lazy",
      resolveRevision,
      async getKeys() {
        return ["current.md"]
      },
      async getItem(key, context) {
        return { key, path: key, content: context.revision?.id || "missing revision" }
      },
    })
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({ name: "materialization-refreshed-revision", sources: { docs: source } }, store)

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [{ revision: { id: "commit-123" }, status: "ready" }],
    })
    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [{ revision: { id: "commit-456" }, status: "ready" }],
    })
    await expect(store.readFile("docs/current.md")).resolves.toMatchObject({ content: "commit-456" })
    expect(resolveRevision).toHaveBeenCalledTimes(2)
  })

  it("keeps an active Source read on its original revision during refresh", async () => {
    const revisions = [
      { id: "commit-123", immutable: true, ref: "main" },
      { id: "commit-456", immutable: true, ref: "main" },
    ]
    const resolveRevision = vi.fn(async () => revisions.shift())
    let releaseRead!: () => void
    let observeRead!: () => void
    const readPending = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const readObserved = new Promise<void>((resolve) => {
      observeRead = resolve
    })
    let blockRead = false
    let blocked = false
    let revisionBeforeAwait: string | undefined
    let revisionAfterAwait: string | undefined
    const source = custom({
      cache: false,
      materialize: "lazy",
      resolveRevision,
      async getKeys() {
        return ["guide.md"]
      },
      async getItem(key, context) {
        if (blockRead && !blocked) {
          blocked = true
          revisionBeforeAwait = context.revision?.id
          observeRead()
          await readPending
          revisionAfterAwait = context.revision?.id
        }
        return { key, path: key, content: context.revision?.id || "missing revision" }
      },
    })
    markLiveWorkspaceSource(source, { "docs/guide.md": "guide.md" })
    const view = createWorkspaceSourceView({ name: "materialization-revision-isolation", sources: { docs: source } }, createMemoryWorkspaceStore())

    await view.materializeSources({ sources: ["docs"] })
    blockRead = true
    const read = view.readFile("docs/guide.md", { encoding: "utf8" })
    await readObserved
    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [{ revision: { id: "commit-456" }, status: "ready" }],
    })
    releaseRead()

    await expect(read).resolves.toBe("commit-123")
    expect(revisionBeforeAwait).toBe("commit-123")
    expect(revisionAfterAwait).toBe("commit-123")
  })

  it("prepares the persistent non-live Source context after signaled explicit materialization", async () => {
    const clients = new WeakMap<object, { keys: string[] }>()
    const prepare = vi.fn(async (context: SourceContext) => {
      clients.set(context, { keys: ["current.md"] })
    })
    const source = custom({
      cache: false,
      materialize: "lazy",
      prepare,
      async getKeys(context: SourceContext) {
        return clients.get(context)?.keys || []
      },
      async getItem(key: string) {
        return { key, path: key, content: "# Current\n" }
      },
    })
    const view = createWorkspaceSourceView({ name: "materialization-persistent-preparation", sources: { docs: source } }, createMemoryWorkspaceStore())
    const abort = new AbortController()

    await expect(view.materializeSources({ abortSignal: abort.signal, sources: ["docs"] })).resolves.toMatchObject({
      sources: [{ status: "ready" }],
    })
    await expect(view.exists("docs/missing.md")).resolves.toBe(false)
    expect(prepare).toHaveBeenCalledOnce()
  })

  it("retries persistent Source preparation after materialization fails", async () => {
    const clients = new WeakMap<object, { keys: string[] }>()
    let attempts = 0
    const source = custom({
      cache: false,
      materialize: "lazy",
      async prepare(context: SourceContext) {
        attempts++
        if (attempts === 1) throw new Error("temporary preparation failure")
        clients.set(context, { keys: ["current.md"] })
      },
      async getKeys(context: SourceContext) {
        return clients.get(context)?.keys || []
      },
      async getItem(key: string) {
        return { key, path: key, content: "# Current\n" }
      },
    })
    const view = createWorkspaceSourceView({ name: "materialization-preparation-retry", sources: { docs: source } }, createMemoryWorkspaceStore())

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [{ error: "temporary preparation failure", status: "error" }],
    })
    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [{ status: "ready" }],
    })
    await expect(view.readFile("docs/current.md", { encoding: "utf8" })).resolves.toBe("# Current\n")
    expect(attempts).toBe(2)
  })

  it("keeps full cache-hit aggregates after scoped materialization", async () => {
    const files = new Map([["a.md", "# A\n"]])
    const view = createWorkspaceSourceView({
      name: "materialization-scoped-cache",
      sources: {
        docs: custom({
          cache: { maxAge: 3600 },
          materialize: "lazy",
          async getKeys() {
            return [...files.keys()]
          },
          async getItem(key) {
            return { key, path: key, content: files.get(key) || "" }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await view.materializeSources({ sources: ["docs"] })
    files.set("b.md", "# B\n")
    const scoped = await view.materializeSources({ path: "docs/b.md", sources: ["docs"] })

    expect(scoped).toMatchObject({ bytes: 4, files: 1 })

    const progress: WorkspaceMaterializeSourcesProgressEvent[] = []
    await expect(view.materializeSources({
      details: "paths",
      onProgress(event) {
        progress.push(event)
      },
      sources: ["docs"],
    })).resolves.toMatchObject({
      files: 2,
      bytes: 8,
      sources: [{
        cacheStatus: "miss",
        counts: { added: 0, removed: 0, unchanged: 2, updated: 0 },
        files: 2,
        bytes: 8,
        paths: [
          { path: "docs/a.md", status: "unchanged" },
          { path: "docs/b.md", status: "unchanged" },
        ],
      }],
    })
    expect(progress.at(-1)).toMatchObject({ bytes: 8, files: 2, status: "completed" })
  })

  it("excludes removed untracked files from scoped snapshot byte deltas", async () => {
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({
      name: "materialization-scoped-untracked-removal",
      sources: {
        docs: custom({
          cache: { maxAge: 3600 },
          materialize: "lazy",
          async getKeys() {
            return ["guides/a.md", "reference/b.md"]
          },
          async getItem(key) {
            return { key, path: key, content: key.endsWith("a.md") ? "# A\n" : "# BB\n" }
          },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })
    await store.writeFile("docs/guides/untracked.md", {
      path: "docs/guides/untracked.md",
      content: "not in the Source snapshot",
    })
    await view.materializeSources({ path: "docs/guides", sources: ["docs"] })

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      bytes: 9,
      files: 2,
      sources: [{ bytes: 9, cacheStatus: "miss", files: 2 }],
    })
    await expect(store.stat("docs/guides/untracked.md")).resolves.toBeUndefined()
  })

  it("excludes replaced untracked files from scoped snapshot byte deltas", async () => {
    const store = createMemoryWorkspaceStore()
    let files = ["reference/b.md"]
    const view = createWorkspaceSourceView({
      name: "materialization-scoped-untracked-replacement",
      sources: {
        docs: custom({
          cache: { maxAge: 3600 },
          materialize: "lazy",
          async getKeys() {
            return files
          },
          async getItem(key) {
            return { key, path: key, content: key.endsWith("a.md") ? "# A\n" : "# BB\n" }
          },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })
    await store.writeFile("docs/guides/a.md", {
      path: "docs/guides/a.md",
      content: "untracked content longer than the source file",
    })
    files = ["guides/a.md", "reference/b.md"]
    await view.materializeSources({ path: "docs/guides", sources: ["docs"] })

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      bytes: 9,
      files: 2,
      sources: [{ bytes: 9, cacheStatus: "miss", files: 2 }],
    })
  })

  it("composes concurrent scoped materialization snapshots", async () => {
    const files = new Map([
      ["a.md", "# A\n"],
    ])
    const view = createWorkspaceSourceView({
      name: "materialization-concurrent-scoped-cache",
      sources: {
        docs: custom({
          cache: { maxAge: 3600 },
          materialize: "lazy",
          async getKeys() {
            return [...files.keys()]
          },
          async getItem(key) {
            return { key, path: key, content: files.get(key) || "" }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await view.materializeSources({ sources: ["docs"] })
    files.set("b.md", "# B\n")
    files.set("c.md", "# CC\n")
    await Promise.all([
      view.materializeSources({ path: "docs/b.md", sources: ["docs"] }),
      view.materializeSources({ path: "docs/c.md", sources: ["docs"] }),
    ])

    await expect(view.materializeSources({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      bytes: 13,
      files: 3,
      sources: [{
        bytes: 13,
        files: 3,
        paths: [
          { path: "docs/a.md", status: "unchanged" },
          { path: "docs/b.md", status: "unchanged" },
          { path: "docs/c.md", status: "unchanged" },
        ],
      }],
    })
  })

  it("reports completed removals before a later cleanup failure", async () => {
    let files = ["a.md", "b.md", "c.md"]
    const progress: unknown[] = []
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({
      name: "materialization-removal-failure",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          async getKeys() {
            return files
          },
          async getItem(key) {
            return { key, path: key, content: `# ${key}\n` }
          },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })
    files = ["c.md"]
    const remove = store.rm.bind(store)
    store.rm = vi.fn(async (path, options) => {
      if (path === "docs/b.md") throw new Error("remove failed")
      await remove(path, options)
    })

    const result = await view.materializeSources({
      details: "paths",
      onProgress(event) {
        progress.push(event)
      },
      sources: ["docs"],
    })

    expect(result.sources[0]).toMatchObject({
      counts: { added: 0, removed: 1, unchanged: 1, updated: 0 },
      error: "remove failed",
      paths: expect.arrayContaining([{ path: "docs/a.md", status: "removed" }]),
      status: "error",
    })
    expect(progress.at(-1)).toMatchObject({
      counts: { added: 0, removed: 1, unchanged: 1, updated: 0 },
      error: "remove failed",
      status: "failed",
    })
    await expect(store.stat("docs/a.md")).resolves.toBeUndefined()
    await expect(store.stat("docs/b.md")).resolves.toMatchObject({ type: "file" })
  })

  it("does not rematerialize an explicitly materialized path during listing", async () => {
    const getItem = vi.fn(async (key: string) => ({ key, path: key, content: "# A\n" }))
    const prepare = vi.fn()
    const view = createWorkspaceSourceView({
      name: "explicit-materialization-listing",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          prepare,
          async getKeys() {
            return ["guides/a.md"]
          },
          getItem,
        }),
      },
    }, createMemoryWorkspaceStore())

    await view.materializeSources({ path: "docs", sources: ["docs"] })
    await expect(view.list("docs/guides", { recursive: true })).resolves.toEqual([
      expect.objectContaining({ path: "docs/guides/a.md", type: "file" }),
    ])
    expect(getItem).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledOnce()
  })

  it("retries a failed explicit scope for the path required by lazy access", async () => {
    let fail = true
    const view = createWorkspaceSourceView({
      name: "failed-scoped-materialization",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          async getKeys() {
            if (fail) {
              fail = false
              throw new Error("temporary source failure")
            }
            return ["a.md", "b.md"]
          },
          async getItem(key) {
            return { key, path: key, content: `# ${key}\n` }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.materializeSources({ path: "docs", sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({ status: "error" })],
    })
    await expect(view.readFile("docs/b.md", { encoding: "utf8" })).resolves.toBe("# b.md\n")
  })

  it("does not reuse failed materialization cancellation for a lazy retry", async () => {
    let fail = true
    const abort = new AbortController()
    const view = createWorkspaceSourceView({
      name: "failed-materialization-cancellation",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          async getKeys() {
            if (fail) {
              fail = false
              throw new Error("temporary source failure")
            }
            return ["b.md"]
          },
          async getItem(key) {
            return { key, path: key, content: `# ${key}\n` }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.materializeSources({ abortSignal: abort.signal, path: "docs", sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({ status: "error" })],
    })
    abort.abort(new DOMException("Canceled", "AbortError"))
    await expect(view.readFile("docs/b.md", { encoding: "utf8" })).resolves.toBe("# b.md\n")
  })

  it("materializes an uncovered sibling after a scoped lazy access", async () => {
    const preparedVersions = new WeakMap<SourceContext, number>()
    const prepare = vi.fn(async (context: SourceContext) => {
      preparedVersions.set(context, prepare.mock.calls.length)
    })
    const getItem = vi.fn(async (key: string, context: SourceContext) => ({
      key,
      path: key,
      content: `# ${key} v${preparedVersions.get(context)}\n`,
    }))
    const view = createWorkspaceSourceView({
      name: "sibling-scoped-materialization",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          prepare,
          async getKeys() {
            return ["a.md", "b.md"]
          },
          getItem,
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.readFile("docs/a.md", { encoding: "utf8" })).resolves.toBe("# a.md v1\n")
    await expect(view.readFile("docs/b.md", { encoding: "utf8" })).resolves.toBe("# b.md v2\n")
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(getItem).toHaveBeenCalledTimes(2)
  })

  it("refreshes a revision before materializing an uncovered sibling", async () => {
    const revisions = [
      { id: "commit-123", immutable: true, ref: "main" },
      { id: "commit-456", immutable: true, ref: "main" },
    ]
    const resolveRevision = vi.fn(async () => revisions.shift())
    const view = createWorkspaceSourceView({
      name: "sibling-revision-materialization",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          resolveRevision,
          async getKeys() {
            return ["a/guide.md", "b/guide.md"]
          },
          async getItem(key, context) {
            return { key, path: key, content: context.revision?.id || "missing revision" }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await view.list("docs/a", { recursive: true })
    await expect(view.readFile("docs/a/guide.md", { encoding: "utf8" })).resolves.toBe("commit-123")
    await view.list("docs/b", { recursive: true })
    await expect(view.readFile("docs/b/guide.md", { encoding: "utf8" })).resolves.toBe("commit-456")
    expect(resolveRevision).toHaveBeenCalledTimes(2)
  })

  it("shares and reuses successful pathless lazy materialization", async () => {
    let release!: () => void
    const getKeys = vi.fn(async () => {
      await new Promise<void>(resolve => release = resolve)
      return ["a.md"]
    })
    const getItem = vi.fn(async (key: string) => ({ key, path: key, content: `# ${key}\n` }))
    const view = createWorkspaceSourceView({
      name: "pathless-materialization-reuse",
      sources: {
        docs: custom({ cache: false, materialize: "lazy", getItem, getKeys }),
      },
    }, createMemoryWorkspaceStore())

    const first = view.glob("docs/**")
    await vi.waitFor(() => expect(getKeys).toHaveBeenCalledOnce())
    const second = view.glob("docs/**")
    release()

    await Promise.all([first, second])
    await view.glob("docs/**")
    expect(getKeys).toHaveBeenCalledOnce()
    expect(getItem).toHaveBeenCalledOnce()
  })

  it("serializes implicit lazy access with explicit materialization", async () => {
    let releaseFirst!: () => void
    let calls = 0
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({
      name: "implicit-explicit-materialization",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          async getKeys() {
            const call = ++calls
            if (call === 1) await new Promise<void>(resolve => releaseFirst = resolve)
            return [call === 1 ? "a.md" : "b.md"]
          },
          async getItem(key) {
            return { key, path: key, content: `# ${key}\n` }
          },
        }),
      },
    }, store)

    const explicit = view.materializeSources({ sources: ["docs"] })
    await vi.waitFor(() => expect(calls).toBe(1))
    const implicit = view.glob("docs/**")
    releaseFirst()
    await Promise.all([explicit, implicit])

    await expect(store.getMeta?.("source:docs:snapshot")).resolves.toMatchObject({
      bytes: 7,
      files: 1,
      items: {
        "docs/a.md": expect.objectContaining({ sourcePath: "a.md" }),
      },
    })
  })

  it("retries a covered path after an explicit refresh fails", async () => {
    let attempt = 0
    const getKeys = vi.fn(async () => {
      attempt++
      if (attempt === 2) throw new Error("temporary refresh failure")
      return ["a.md"]
    })
    const view = createWorkspaceSourceView({
      name: "failed-covered-materialization",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          getKeys,
          async getItem(key) {
            return { key, path: key, content: `# ${key}\n` }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await view.materializeSources({ path: "docs", sources: ["docs"] })
    await expect(view.materializeSources({ path: "docs", sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({ status: "error" })],
    })
    await expect(view.glob("docs/**")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/a.md", type: "file" }),
    ]))
    expect(getKeys).toHaveBeenCalledTimes(3)
  })

  it("retries a covered path after an active refresh is canceled", async () => {
    let attempt = 0
    let observeRefresh!: () => void
    const refreshObserved = new Promise<void>((resolve) => {
      observeRefresh = resolve
    })
    const getKeys = vi.fn(async (context: SourceContext) => {
      attempt++
      if (attempt === 2) {
        observeRefresh()
        await new Promise<void>((resolve) => {
          context.abortSignal?.addEventListener("abort", () => resolve(), { once: true })
        })
        context.abortSignal?.throwIfAborted()
      }
      return ["a.md"]
    })
    const view = createWorkspaceSourceView({
      name: "canceled-covered-materialization",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          getKeys,
          async getItem(key) {
            return { key, path: key, content: `# ${key}\n` }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await view.materializeSources({ path: "docs", sources: ["docs"] })
    const abort = new AbortController()
    const refresh = view.materializeSources({ abortSignal: abort.signal, path: "docs", sources: ["docs"] })
    await refreshObserved
    abort.abort(new DOMException("Canceled", "AbortError"))

    await expect(refresh).rejects.toThrow("Canceled")
    await expect(view.glob("docs/**")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/a.md", type: "file" }),
    ]))
    expect(getKeys).toHaveBeenCalledTimes(3)
  })

  it("compares bulk source contents when reporting file deltas", async () => {
    let content = "# Same\n"
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({
      name: "bulk-materialization-deltas",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          async getItems() {
            return [{ key: "a.md", path: "a.md", content }]
          },
          async getKeys() {
            return ["a.md"]
          },
          async getItem(key) {
            return { key, path: key, content }
          },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })
    const readFile = vi.spyOn(store, "readFile")
    await expect(view.materializeSources({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      sources: [{
        counts: { added: 0, removed: 0, unchanged: 1, updated: 0 },
        paths: [{ path: "docs/a.md", status: "unchanged" }],
      }],
    })
    expect(readFile).toHaveBeenCalledOnce()

    content = "# Changed\n"
    await expect(view.materializeSources({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      sources: [{
        counts: { added: 0, removed: 0, unchanged: 0, updated: 1 },
        paths: [{ path: "docs/a.md", status: "updated" }],
      }],
    })
  })

  it("measures reused files when the Store stat omits size", async () => {
    const store = createMemoryWorkspaceStore()
    const stat = store.stat.bind(store)
    store.stat = async (path) => {
      const result = await stat(path)
      if (!result) return result
      return { ...result, size: undefined }
    }
    const view = createWorkspaceSourceView({
      name: "size-less-reused-materialization",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          async getKeys() {
            return ["a.md"]
          },
          async getMeta() {
            return { etag: "same" }
          },
          async getItem(key) {
            return { key, path: key, content: "# Same\n" }
          },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })
    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      bytes: 7,
      sources: [{ bytes: 7, counts: { added: 0, removed: 0, unchanged: 1, updated: 0 } }],
    })
  })

  it("reports materialized file attribute changes as updates", async () => {
    vi.useFakeTimers()
    vi.setSystemTime("2026-01-01T00:00:00.000Z")
    let mediaType: string | undefined
    let metadata = { category: "draft" }
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({
      name: "materialization-attribute-deltas",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          async getItems() {
            return [{ key: "a.md", path: "a.md", content: "# Same\n", mediaType, metadata }]
          },
          async getKeys() {
            return ["a.md"]
          },
          async getItem(key) {
            return { key, path: key, content: "# Same\n", mediaType, metadata }
          },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })
    mediaType = "text/markdown"
    vi.advanceTimersByTime(1_000)
    await expect(view.materializeSources({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      sources: [{
        counts: { added: 0, removed: 0, unchanged: 0, updated: 1 },
        paths: [{ path: "docs/a.md", status: "updated" }],
      }],
    })

    metadata = { category: "published" }
    const progress: WorkspaceMaterializeSourcesProgressEvent[] = []
    vi.advanceTimersByTime(1_000)
    await expect(view.materializeSources({
      details: "paths",
      sources: ["docs"],
      onProgress(event) {
        progress.push(event)
      },
    })).resolves.toMatchObject({
      sources: [{
        counts: { added: 0, removed: 0, unchanged: 0, updated: 1 },
        paths: [{ path: "docs/a.md", status: "updated" }],
      }],
    })
    expect(progress.at(-1)).toMatchObject({
      counts: { added: 0, removed: 0, unchanged: 0, updated: 1 },
      status: "completed",
    })
    await expect(store.stat("docs/a.md")).resolves.toMatchObject({
      mediaType: "text/markdown",
      metadata: expect.objectContaining({ category: "published" }),
    })

    vi.advanceTimersByTime(1_000)
    await expect(view.materializeSources({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      sources: [{
        counts: { added: 0, removed: 0, unchanged: 1, updated: 0 },
        paths: [{ path: "docs/a.md", status: "unchanged" }],
      }],
    })
  })

  it("reports unchanged files after a Local Store restart omits optional file attributes", async () => {
    const root = await createRoot()
    const definition = {
      name: "attribute-less-materialization-deltas",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          async getKeys() {
            return ["a.md"]
          },
          async getItem(key) {
            return {
              key,
              path: key,
              content: "# Same\n",
              mediaType: "text/markdown",
              metadata: { category: "published" },
            }
          },
        }),
      },
    }

    await createWorkspaceSourceView(definition, createLocalWorkspaceStore(root)).materializeSources({ sources: ["docs"] })
    const restarted = createWorkspaceSourceView(definition, createLocalWorkspaceStore(root))
    await expect(restarted.materializeSources({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      sources: [{
        counts: { added: 0, removed: 0, unchanged: 1, updated: 0 },
        paths: [{ path: "docs/a.md", status: "unchanged" }],
      }],
    })
  })

  it("reports file deltas when the Store omits snapshot metadata", async () => {
    let content = "# Same\n"
    const store = createMemoryWorkspaceStore()
    Object.defineProperties(store, {
      getMeta: { value: undefined },
      setMeta: { value: undefined },
    })
    const view = createWorkspaceSourceView({
      name: "metadata-less-materialization-deltas",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          async getKeys() {
            return ["a.md"]
          },
          async getItem(key) {
            return { key, path: key, content }
          },
        }),
      },
    }, store)

    await expect(view.materializeSources({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      sources: [{
        counts: { added: 1, removed: 0, unchanged: 0, updated: 0 },
        paths: [{ path: "docs/a.md", status: "added" }],
      }],
    })
    await expect(view.materializeSources({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      sources: [{
        counts: { added: 0, removed: 0, unchanged: 1, updated: 0 },
        paths: [{ path: "docs/a.md", status: "unchanged" }],
      }],
    })

    content = "# Changed\n"
    await expect(view.materializeSources({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      sources: [{
        counts: { added: 0, removed: 0, unchanged: 0, updated: 1 },
        paths: [{ path: "docs/a.md", status: "updated" }],
      }],
    })
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

  it("reports a revision resolved before source preparation fails", async () => {
    const progress: WorkspaceMaterializeSourcesProgressEvent[] = []
    const view = createWorkspaceSourceView({
      name: "failed-preparation-revision",
      sources: {
        docs: custom({
          materialize: "lazy",
          async resolveRevision() {
            return { id: "commit-prepare-broken", immutable: true, ref: "main" }
          },
          async prepare() {
            throw new Error("prepare failed")
          },
          async getKeys() {
            return []
          },
          async getItem(key) {
            return { key, path: key, content: "" }
          },
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.materializeSources({
      onProgress(event) {
        progress.push(event)
      },
      sources: ["docs"],
    })).resolves.toMatchObject({
      sources: [{
        error: "prepare failed",
        revision: { id: "commit-prepare-broken", immutable: true, ref: "main" },
        source: "docs",
        status: "error",
      }],
    })
    expect(progress.at(-1)).toMatchObject({
      error: "prepare failed",
      revision: { id: "commit-prepare-broken", immutable: true, ref: "main" },
      status: "failed",
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

  it("invalidates broad lazy coverage after a scoped revision refresh", async () => {
    let revision = 0
    const getItem = vi.fn(async (key: string, context) => ({
      key,
      content: `${context.revision.id}:${key}\n`,
    }))
    const view = createWorkspaceSourceView({
      name: "scoped-revision-refresh",
      sources: {
        docs: custom({
          cache: { maxAge: 3600 },
          materialize: "lazy",
          async resolveRevision() {
            revision++
            return { id: `commit-${revision}`, immutable: true }
          },
          async getKeys() {
            return ["a.md", "b.md"]
          },
          getItem,
        }),
      },
    }, createMemoryWorkspaceStore())

    await view.materializeSources({ sources: ["docs"] })
    await view.materializeSources({ path: "docs/a.md", sources: ["docs"] })
    await expect(view.glob("docs/**")).resolves.toHaveLength(2)
    expect(getItem).toHaveBeenCalledTimes(5)
    await expect(view.readFile("docs/a.md")).resolves.toBe("commit-3:a.md\n")
    await expect(view.readFile("docs/b.md")).resolves.toBe("commit-3:b.md\n")
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

  it("counts streamed bytes when the Store omits stat size", async () => {
    const root = await createRoot()
    const store = createLocalWorkspaceStore(root)
    const writeFileStream = store.writeFileStream!.bind(store)
    store.writeFileStream = async (path, file) => {
      const stat = await writeFileStream(path, file)
      return { ...stat, size: undefined }
    }
    const view = createWorkspaceSourceView({
      name: "lazy-stream-size",
      sources: {
        docs: custom({
          cache: { maxAge: 3600 },
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
            }
          },
        }),
      },
    }, store)

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      bytes: 5,
      sources: [{ bytes: 5, status: "ready" }],
    })
    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      bytes: 5,
      sources: [{ bytes: 5, cacheStatus: "hit" }],
    })
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

  it("invalidates a cached snapshot when scoped materialization is canceled after a write", async () => {
    const abort = new AbortController()
    let cancel = false
    const contents = new Map([
      ["guides/a.md", "# A1\n"],
      ["guides/b.md", "# B1\n"],
    ])
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({
      name: "lazy-mutated-scoped-cancel",
      sources: {
        docs: custom({
          cache: { maxAge: 3600 },
          materialize: "lazy",
          async getKeys() {
            return [...contents.keys()]
          },
          async getItem(key) {
            if (key === "guides/b.md" && cancel) {
              cancel = false
              abort.abort(new DOMException("Canceled", "AbortError"))
              abort.signal.throwIfAborted()
            }
            return { key, path: key, content: contents.get(key) || "" }
          },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })
    contents.set("guides/a.md", "# A2\n")
    contents.set("guides/b.md", "# B2\n")
    cancel = true
    await expect(view.materializeSources({
      abortSignal: abort.signal,
      path: "docs/guides",
      sources: ["docs"],
    })).rejects.toThrow("Canceled")

    await expect(store.getMeta?.("source:docs:snapshot")).resolves.toMatchObject({
      bytes: 10,
      files: 2,
      materializedAt: undefined,
      status: "updating",
    })
    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [{ bytes: 10, cacheStatus: "miss", files: 2 }],
    })
    await expect(view.readFile("docs/guides/a.md")).resolves.toBe("# A2\n")
    await expect(view.readFile("docs/guides/b.md")).resolves.toBe("# B2\n")
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
})
