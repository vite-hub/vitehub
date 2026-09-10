import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import type { WorkspaceStore } from "../src/index.ts"

import { normalizeWorkspaceSource, normalizeWorkspaceSources } from "../src/sources/config.ts"
import { createWorkspaceSourceView, invalidateWorkspaceSourceMaterialization } from "../src/sources/view.ts"
import { markLiveWorkspaceSource } from "../src/sources/live.ts"
import { createWorkspace, custom, defineWorkspace, github, glob } from "../src/index.ts"
import { resetWorkspaceRegistry } from "../src/core/registry.ts"
import { registerWorkspace } from "../src/test.ts"
import { useRegisteredWorkspace } from "../src/core/registry.ts"
const globSource = glob
const githubSource = github
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { materializeWorkspaceSources, readCurrentSourceSnapshot } from "../src/sources/materialization.ts"

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
  it.each([false, true])("refreshes legacy cached snapshots without content digests with attributes=%s", async (attributes) => {
    const store = createMemoryWorkspaceStore()
    const getItem = vi.fn(async (key: string) => ({ key, content: "generated" }))
    const definition = {
      name: "legacy-startup-cache",
      sources: {
        docs: custom({ materialize: "startup", cache: { maxAge: 3600 }, getKeys: async () => ["guide.md"], getItem }),
      },
    }
    await materializeWorkspaceSources(definition, store)
    const snapshot = await readCurrentSourceSnapshot(store, normalizeWorkspaceSource("docs", definition.sources.docs))
    const item = snapshot!.items!["docs/guide.md"]!
    delete item.materializedContentDigest
    if (!attributes) delete item.materializedAttributes
    await store.setMeta?.("source:docs:snapshot", snapshot)
    const file = await store.readFile("docs/guide.md")
    await store.writeFile("docs/guide.md", { ...file!, content: "changed" })
    getItem.mockClear()

    await materializeWorkspaceSources(definition, store)

    expect(getItem).toHaveBeenCalledOnce()
    await expect(store.readFile("docs/guide.md")).resolves.toMatchObject({ content: "generated" })
    const refreshed = await readCurrentSourceSnapshot(store, normalizeWorkspaceSource("docs", definition.sources.docs))
    expect(refreshed!.items!["docs/guide.md"]!.materializedContentDigest).toBeTruthy()
    await materializeWorkspaceSources(definition, store)
    expect(getItem).toHaveBeenCalledOnce()
  })

  it.each([false, true])("reuses fresh Local Store snapshots after reopening (changed content: %s)", async (changedContent) => {
    const root = await createRoot()
    const getKeys = vi.fn(async () => ["guide.md"])
    const getItem = vi.fn(async (key: string) => ({ key, content: "guide", mediaType: "text/markdown", metadata: { label: "guide" } }))
    const definition = {
      name: "reopened-startup-cache",
      sources: {
        docs: custom({ materialize: "startup", mount: "docs", cache: { maxAge: 3600 }, getKeys, getItem }),
      },
    }
    await materializeWorkspaceSources(definition, createLocalWorkspaceStore(root))
    getKeys.mockClear()
    getItem.mockClear()
    if (changedContent) await writeFile(join(root, "docs/guide.md"), "changed")

    const reopened = createLocalWorkspaceStore(root)
    await expect(reopened.readFile("docs/guide.md")).resolves.toMatchObject({ mediaType: undefined, metadata: undefined })
    const result = await materializeWorkspaceSources(definition, reopened)

    expect(result.sources[0]?.status).toBe("ready")
    expect(getKeys).toHaveBeenCalledTimes(1)
    expect(getItem).toHaveBeenCalledTimes(1)
    expect(Buffer.from((await reopened.readFile("docs/guide.md"))!.content).toString()).toBe("guide")
  })

  it.each(["memory", "local"])("restores the selected startup Source before point reads on %s", async (storeType) => {
    for (const operation of ["readFile", "stat", "exists"] as const) {
      for (const content of ["second", "first"]) {
        const store = storeType === "memory" ? createMemoryWorkspaceStore() : createLocalWorkspaceStore(await createRoot())
        const definition = {
          name: "startup-point-precedence",
          sources: {
            first: custom({ materialize: "startup", mount: "docs", cache: { maxAge: 3600 }, files: [{ path: "shared.md", content: "first", mediaType: "text/markdown" }] }),
            second: custom({ materialize: "startup", mount: "docs", cache: { maxAge: 3600 }, files: [{ path: "shared.md", content, mediaType: "text/plain" }] }),
          },
        }
        const view = createWorkspaceSourceView(definition, store)
        await view.materializeSources()
        await view.materializeSources({ sources: ["second"], path: "docs/shared.md" })
        await expect(store.readFile("docs/shared.md")).resolves.toMatchObject({ metadata: { source: "second" } })

        const result = await view[operation]("docs/shared.md")
        expect(result).toEqual(operation === "readFile" ? "first" : operation === "exists" ? true : expect.objectContaining({ type: "file" }))
        const restored = await store.readFile("docs/shared.md")
        expect(Buffer.from(restored!.content).toString()).toBe("first")
        expect(restored).toMatchObject({ mediaType: "text/markdown", metadata: { source: "first" } })
      }
    }
  })

  it.each(["memory", "local"])("restores cached startup precedence after a scoped lower-priority write on %s", async (storeType) => {
    const store = storeType === "memory" ? createMemoryWorkspaceStore() : createLocalWorkspaceStore(await createRoot())
    const definition = {
      name: "cached-startup-precedence",
      sources: {
        first: custom({ materialize: "startup", mount: "", cache: { maxAge: 3600 }, getKeys: async () => ["shared.md"], getMeta: async () => ({ etag: "first-v1" }), getItem: async key => ({ key, content: "first" }) }),
        second: custom({ materialize: "startup", mount: "", cache: { maxAge: 3600 }, files: [{ path: "shared.md", content: "second" }] }),
      },
    }
    await materializeWorkspaceSources(definition, store)
    expect(Buffer.from((await store.readFile("shared.md"))!.content).toString()).toBe("first")
    await materializeWorkspaceSources(definition, store, { sources: ["second"], path: "shared.md" })
    expect(Buffer.from((await store.readFile("shared.md"))!.content).toString()).toBe("second")

    const result = await materializeWorkspaceSources(definition, store)
    expect(result.sources.every(source => source.status === "ready")).toBe(true)
    expect(Buffer.from((await store.readFile("shared.md"))!.content).toString()).toBe("first")
  })

  it.each(["memory", "local"])("restores cached startup attributes after an equal-content scoped write on %s", async (storeType) => {
    const store = storeType === "memory" ? createMemoryWorkspaceStore() : createLocalWorkspaceStore(await createRoot())
    const definition = {
      name: "cached-startup-attributes",
      sources: {
        first: custom({ materialize: "startup", mount: "", cache: { maxAge: 3600 }, getKeys: async () => ["shared.md"], getMeta: async () => ({ etag: "first-v1" }), getItem: async key => ({ key, content: "same", mediaType: "text/markdown", metadata: { label: "first" } }) }),
        second: custom({ materialize: "startup", mount: "", cache: { maxAge: 3600 }, files: [{ path: "shared.md", content: "same", mediaType: "text/plain", metadata: { label: "second" } }] }),
      },
    }
    await materializeWorkspaceSources(definition, store)
    const expected = await store.readFile("shared.md")
    await materializeWorkspaceSources(definition, store, { sources: ["second"], path: "shared.md" })
    await expect(store.readFile("shared.md")).resolves.toMatchObject({ mediaType: "text/plain", metadata: { label: "second", source: "second" } })

    const result = await materializeWorkspaceSources(definition, store)
    expect(result.sources.every(source => source.status === "ready")).toBe(true)
    const restored = await store.readFile("shared.md")
    expect(restored?.content).toEqual(expected?.content)
    expect(restored?.mediaType).toBe("text/markdown")
    expect(restored?.metadata).toMatchObject({ label: "first", source: "first" })
  })

  it.each([false, true])("isolates startup cleanup for Workspaces sharing a Store with abortable sync %s", async (abortableSync) => {
    const store = createMemoryWorkspaceStore()
    const first = {
      name: "first-workspace",
      sources: { first: custom({ materialize: "startup", mount: "first", files: [{ path: "file.md", content: "first" }] }) },
    }
    const second = {
      name: "second-workspace",
      sources: { second: custom({ materialize: "startup", mount: "second", files: [{ path: "file.md", content: "second" }] }) },
    }
    await createWorkspaceSourceView(first, store).materializeSources()
    await syncWorkspaceDefinition(second, store, abortableSync ? new AbortController().signal : undefined)
    await expect(store.readFile("first/file.md")).resolves.toMatchObject({ content: "first" })
    await createWorkspaceSourceView(second, store).materializeSources()
    await expect(store.readFile("first/file.md")).resolves.toMatchObject({ content: "first" })

    await createWorkspaceSourceView({ name: first.name, sources: {} }, store).materializeSources()
    await expect(store.stat("first/file.md")).resolves.toBeUndefined()
    await expect(store.readFile("second/file.md")).resolves.toMatchObject({ content: "second" })
    await syncWorkspaceDefinition({ name: second.name, sources: {} }, store, abortableSync ? new AbortController().signal : undefined)
    await expect(store.stat("second/file.md")).resolves.toBeUndefined()
  })

  it.each([false, true].flatMap(readFirst => ["stat", "exists"].flatMap(operation => ["memory", "local"].map(storeType => ({ readFirst, operation, storeType })))))("preserves root startup precedence after $operation with an earlier read=$readFirst on $storeType", async ({ readFirst, operation, storeType }) => {
    const definition = {
      name: "startup-stat-precedence",
      sources: {
        first: custom({ materialize: "startup", mount: "", files: [{ path: "shared.md", content: "first" }] }),
        second: custom({ materialize: "startup", mount: "", files: [{ path: "shared.md", content: "second" }] }),
      },
    }
    const store = storeType === "local" ? createLocalWorkspaceStore(await createRoot()) : createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView(definition, store)
    if (readFirst) await expect(view.readFile("shared.md")).resolves.toBe("first")
    if (operation === "stat") await expect(view.stat("shared.md")).resolves.toMatchObject({ type: "file" })
    else await expect(view.exists("shared.md")).resolves.toBe(true)
    await expect(view.readFile("shared.md")).resolves.toBe("first")
  })

  it.each([false, true].flatMap(readFirst => ["list", "glob"].flatMap(operation => ["memory", "local"].map(storeType => ({ readFirst, operation, storeType })))))("preserves startup source precedence after $operation with an earlier read=$readFirst on $storeType", async ({ readFirst, operation, storeType }) => {
    const definition = {
      name: "startup-list-precedence",
      sources: {
        first: custom({ materialize: "startup", mount: "docs", files: [{ path: "shared.md", content: "first" }] }),
        second: custom({ materialize: "startup", mount: "docs", files: [{ path: "shared.md", content: "second" }] }),
        root: custom({ materialize: "startup", mount: "", files: [{ path: "docs/shared.md", content: "root" }] }),
      },
    }
    const store = storeType === "local" ? createLocalWorkspaceStore(await createRoot()) : createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView(definition, store)
    if (readFirst) await expect(view.readFile("docs/shared.md")).resolves.toBe("first")
    if (operation === "glob") await view.glob("docs/**/*.md")
    else await view.list("docs", { recursive: true })
    await expect(view.readFile("docs/shared.md")).resolves.toBe("first")
    if (operation === "glob") await view.glob("**/*.md")
    else await view.list("", { recursive: true })
    await expect(view.readFile("docs/shared.md")).resolves.toBe("first")
  })

  it.each([false, true].flatMap(readFirst => [undefined, ["docs"]].map(paths => ({ readFirst, paths }))))("preserves startup source precedence during search with an earlier read=$readFirst and paths=$paths", async ({ readFirst, paths }) => {
    const definition = {
      name: "startup-search-precedence",
      sources: {
        first: custom({ materialize: "startup", mount: "docs", files: [{ path: "shared.md", content: "first needle" }] }),
        second: custom({ materialize: "startup", mount: "docs", files: [{ path: "shared.md", content: "second needle" }] }),
        root: custom({ materialize: "startup", mount: "", files: [{ path: "docs/shared.md", content: "root needle" }] }),
      },
    }
    const view = createWorkspaceSourceView(definition, createMemoryWorkspaceStore())
    if (readFirst) await expect(view.readFile("docs/shared.md")).resolves.toBe("first needle")
    const hits = await view.search({ pattern: "first needle", paths })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.path).toBe("docs/shared.md")
    await expect(view.readFile("docs/shared.md")).resolves.toBe("first needle")
    await expect(view.search({ pattern: "second needle|root needle", regex: true, paths })).resolves.toEqual([])
  })

  it.each(["search", "list"].flatMap(operation => [false, true].flatMap(local => ["", "docs"].map(mount => ({ operation, local, mount })))))("preserves overlapping inspection snapshots during $operation with local=$local and mount=$mount", async ({ operation, local, mount }) => {
    const rootDir = await mkdtemp(join(tmpdir(), "workspace-inspection-overlap-"))
    tempDirs.push(rootDir)
    const store = local ? createLocalWorkspaceStore(rootDir) : createMemoryWorkspaceStore()
    let content = "persisted needle"
    const getItem = vi.fn(async (key: string) => ({ key, content }))
    const definition = {
      name: "inspection-overlap",
      sources: {
        first: custom({ materialize: "startup", mount: "docs", getKeys: async () => ["shared.md"], getItem }),
        second: custom({ materialize: "startup", mount, files: [{ path: mount ? "shared.md" : "docs/shared.md", content: "lower needle" }] }),
      },
    }
    await createWorkspaceSourceView(definition, store).readFile("docs/shared.md")
    const snapshot = await store.getMeta?.("source:first:snapshot")
    content = "upstream needle"
    getItem.mockClear()
    const view = createWorkspaceSourceView({ ...definition }, store, { reuseStartupSnapshots: true })
    if (operation === "search") {
      await expect(view.search({ pattern: "needle" })).resolves.toEqual([
        expect.objectContaining({ path: "docs/shared.md", text: "persisted needle" }),
      ])
    }
    else {
      await expect(view.list("docs", { recursive: true })).resolves.toEqual([
        expect.objectContaining({ path: "docs/shared.md" }),
      ])
    }
    expect(getItem).not.toHaveBeenCalled()
    await expect(view.readFile("docs/shared.md")).resolves.toBe("persisted needle")
    const persisted = await store.readFile("docs/shared.md")
    expect(typeof persisted?.content === "string" ? persisted.content : new TextDecoder().decode(persisted?.content)).toBe("persisted needle")
    await expect(store.getMeta?.("source:first:snapshot")).resolves.toEqual(snapshot)
    await expect(store.getMeta?.("source:second:snapshot")).resolves.toMatchObject({ status: "ready" })
  })

  it.each(["search", "list"].flatMap(operation => [false, true].flatMap(local => [false, true].map(readyLowerSource => ({ operation, local, readyLowerSource })))))("rematerializes incomplete inspection snapshots during $operation with local=$local and readyLowerSource=$readyLowerSource", async ({ operation, local, readyLowerSource }) => {
    const rootDir = await mkdtemp(join(tmpdir(), "workspace-inspection-incomplete-"))
    tempDirs.push(rootDir)
    const store = local ? createLocalWorkspaceStore(rootDir) : createMemoryWorkspaceStore()
    const getItem = vi.fn(async (key: string) => ({ key, content: "higher needle" }))
    const definition = {
      name: "inspection-incomplete",
      sources: {
        first: custom({ materialize: "startup", mount: "docs", getKeys: async () => ["shared.md"], getItem }),
        second: custom({ materialize: "startup", mount: "docs", files: [{ path: "shared.md", content: "lower needle" }] }),
      },
    }
    const initial = createWorkspaceSourceView(definition, store)
    if (readyLowerSource) await initial.list("docs", { recursive: true })
    else await initial.readFile("docs/shared.md")
    await store.rm("docs/shared.md")
    getItem.mockClear()

    const view = createWorkspaceSourceView({ ...definition }, store, { reuseStartupSnapshots: true })
    if (operation === "search") {
      await expect(view.search({ pattern: "needle" })).resolves.toEqual([
        expect.objectContaining({ path: "docs/shared.md", text: "higher needle" }),
      ])
    }
    else {
      await expect(view.list("docs", { recursive: true })).resolves.toEqual([
        expect.objectContaining({ path: "docs/shared.md" }),
      ])
    }
    expect(getItem).toHaveBeenCalled()
    await expect(view.readFile("docs/shared.md")).resolves.toBe("higher needle")
  })

  it.each(["search", "list", "glob"].flatMap(operation => [false, true].map(local => ({ operation, local }))))("rejects failed incomplete snapshot recovery during $operation with local=$local", async ({ operation, local }) => {
    const rootDir = await mkdtemp(join(tmpdir(), "workspace-inspection-recovery-failure-"))
    tempDirs.push(rootDir)
    const store = local ? createLocalWorkspaceStore(rootDir) : createMemoryWorkspaceStore()
    const getItem = vi.fn(async (key: string) => ({ key, content: "higher needle" }))
    const definition = {
      name: "inspection-recovery-failure",
      sources: {
        first: custom({ materialize: "startup", mount: "docs", getKeys: async () => ["shared.md"], getItem }),
        second: custom({ materialize: "startup", mount: "docs", files: [{ path: "shared.md", content: "lower needle" }] }),
      },
    }
    await createWorkspaceSourceView(definition, store).readFile("docs/shared.md")
    await store.rm("docs/shared.md")
    getItem.mockRejectedValue(new Error("provider unavailable"))
    const view = createWorkspaceSourceView({ ...definition }, store, { reuseStartupSnapshots: true })
    const result = operation === "search"
      ? view.search({ pattern: "needle" })
      : operation === "glob" ? view.glob("**/*.md") : view.list("docs", { recursive: true })
    await expect(result).rejects.toThrow("Workspace Source recovery failed: first")
    await expect(store.getMeta?.("source:second:snapshot")).resolves.toMatchObject({ status: "ready" })
    await expect(store.getMeta?.("source:first:snapshot")).resolves.toMatchObject({ status: "error" })
  })

  it.each([false, true].flatMap(local => [false, true].flatMap(reuseStartupSnapshots => (["second", "third"] as const).map(failedSource => ({ local, reuseStartupSnapshots, failedSource })))))("restores higher-priority startup content after a partial $failedSource recovery failure with local=$local and snapshot reuse=$reuseStartupSnapshots", async ({ local, reuseStartupSnapshots, failedSource }) => {
    const store = local ? createLocalWorkspaceStore(await createRoot()) : createMemoryWorkspaceStore()
    const definition = {
      name: "inspection-recovery-precedence",
      sources: {
        first: custom({ materialize: "startup", mount: "docs", files: [{ path: "shared.md", content: "higher" }] }),
        second: custom({ materialize: "startup", mount: "docs", files: [{ path: "shared.md", content: "middle" }] }),
        third: custom({ materialize: "startup", mount: "docs", files: [{ path: "shared.md", content: "lower" }] }),
      },
    }
    await createWorkspaceSourceView(definition, store).readFile("docs/shared.md")
    await store.rm("docs/shared.md")
    const failing = definition.sources[failedSource]
    failing.getKeys = async () => ["shared.md", "unavailable.md"]
    failing.getItem = async (key) => {
      if (key === "unavailable.md") throw new Error("provider unavailable")
      return { key, content: "partial failed source" }
    }
    const writeFile = vi.spyOn(store, "writeFile")
    const view = createWorkspaceSourceView({ ...definition }, store, { reuseStartupSnapshots })
    await expect(view.list("docs", { recursive: true })).rejects.toThrow(`Workspace Source recovery failed: ${failedSource}`)
    expect(writeFile).toHaveBeenCalledWith("docs/shared.md", expect.objectContaining({ content: "partial failed source" }))
    const persisted = await store.readFile("docs/shared.md")
    expect(persisted).toBeDefined()
    expect(typeof persisted!.content === "string" ? persisted!.content : new TextDecoder().decode(persisted!.content)).toBe("higher")
    await expect(view.readFile("docs/shared.md")).resolves.toBe("higher")
  })

  it("refreshes nested startup files before the first directory listing", async () => {
    const store = createMemoryWorkspaceStore()
    let keys = ["stale.md"]
    const definition = {
      name: "nested-startup-list",
      sources: {
        docs: custom({
          materialize: "startup",
          sync: { stale: "remove" },
          async getKeys() { return keys },
          async getItem(key) { return { key, content: key } },
        }),
      },
    }
    await createWorkspaceSourceView(definition, store).materializeSources()
    keys = ["current.md"]
    const view = createWorkspaceSourceView({ ...definition }, store)
    const entries = await view.list("docs", { recursive: true })
    expect(entries.map(entry => entry.path)).toEqual(["docs/current.md"])
    await expect(store.stat("docs/stale.md")).resolves.toBeUndefined()
  })

  it.each([false, true])("rechecks nested startup ownership in an existing view with snapshot reuse=%s", async (reuseStartupSnapshots) => {
    const definition = {
      name: "nested-startup-build-invalidation",
      sources: {
        built: custom({ materialize: "build", mount: "", files: [{ path: "docs/shared.md", content: "build" }] }),
        generated: custom({ materialize: "startup", mount: "docs", files: [{ path: "shared.md", content: "startup" }] }),
      },
    }
    const store = createMemoryWorkspaceStore()
    await createWorkspaceSourceView(definition, store).materializeSources()
    const view = createWorkspaceSourceView({ ...definition }, store, { reuseStartupSnapshots })
    await expect(view.readFile("docs/shared.md")).resolves.toBe("startup")

    await syncWorkspaceDefinition(definition, store)
    await expect(store.readFile("docs/shared.md")).resolves.toMatchObject({ content: "build" })
    await expect(view.readFile("docs/shared.md")).resolves.toBe("startup")
  })

  it.each([false, true])("restores retained startup files after scoped owner cleanup with a new view=%s", async (newView) => {
    const store = createMemoryWorkspaceStore()
    let ownerKeys = ["shared.md"]
    const definition = {
      name: "scoped-owner-cleanup",
      sources: {
        retained: custom({ materialize: "startup", mount: "", files: [{ path: "shared.md", content: "retained" }] }),
        owner: custom({
          materialize: "startup",
          mount: "",
          sync: { stale: "remove" },
          async getKeys() { return ownerKeys },
          async getItem(key) { return { key, content: "owner" } },
        }),
      },
    }
    const view = createWorkspaceSourceView(definition, store)
    await view.materializeSources({ sources: ["retained"] })
    await view.materializeSources({ sources: ["owner"] })
    await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "owner" })

    ownerKeys = []
    await view.materializeSources({ sources: ["owner"] })
    const reader = newView ? createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true }) : view
    await expect(reader.readFile("shared.md", { encoding: "utf8" })).resolves.toBe("retained")
  })

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

  it.each([undefined, false, true].flatMap(recursive => ["", "/", "///"].map(path => ({ recursive, path }))))("materializes startup Sources during the first root listing at $path with recursive=$recursive", async ({ recursive, path }) => {
    const store = createMemoryWorkspaceStore()
    const list = vi.spyOn(store, "list")
    const view = createWorkspaceSourceView({
      name: "startup-root-list",
      sources: {
        instructions: {
          content: "# Instructions\n",
          materialize: "startup",
          mount: "",
          workspacePath: "AGENTS.md",
        },
        skill: {
          content: new TextEncoder().encode("# Review\n"),
          materialize: "startup",
          mount: "",
          workspacePath: ".agents/skills/review/SKILL.md",
        },
      },
    }, store)

    await expect(view.list(path, { recursive })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "AGENTS.md", type: "file" }),
      expect.objectContaining(recursive
        ? { path: ".agents/skills/review/SKILL.md", type: "file" }
        : { path: ".agents", type: "directory" }),
    ]))
    await expect(store.readFile("AGENTS.md")).resolves.toMatchObject({ content: "# Instructions\n" })
    await expect(store.readFile(".agents/skills/review/SKILL.md")).resolves.toMatchObject({
      content: new TextEncoder().encode("# Review\n"),
    })
    // First startup only lists the Store for the consumer, not for source cleanup.
    expect(list).toHaveBeenCalledExactlyOnceWith(path, { recursive })
    // Once snapshots contain item paths, refresh only stats those paths.
    list.mockClear()
    await view.materializeSources()
    expect(list).not.toHaveBeenCalled()
  })

  it.each([false, true])("refreshes non-recursive root listings with snapshot reuse=%s", async (reuseStartupSnapshots) => {
    const store = createMemoryWorkspaceStore()
    let keys = ["stale.md"]
    const definition = {
      name: "startup-root-list-refresh",
      sources: {
        instructions: custom({
          mount: "",
          materialize: "startup" as const,
          async getKeys() { return keys },
          async getItem(key) { return { key, content: key } },
        }),
      },
    }
    await createWorkspaceSourceView(definition, store).materializeSources()
    keys = ["AGENTS.md"]
    const view = createWorkspaceSourceView({ ...definition }, store, { reuseStartupSnapshots })

    await expect(view.list()).resolves.toEqual([
      expect.objectContaining({ path: reuseStartupSnapshots ? "stale.md" : "AGENTS.md", type: "file" }),
    ])
  })

  it.each(["", "docs"])("omits deleted startup files from the first recursive listing at mount '%s'", async (mount) => {
    let keys = ["stale.md", "current.md"]
    const definition = {
      name: "startup-root-list-refresh",
      sources: {
        docs: custom({
          materialize: "startup" as const,
          mount,
          async getKeys() { return keys },
          async getItem(key) { return { key, content: key } },
        }),
        pending: custom({
          materialize: "lazy" as const,
          async getKeys() { return ["later.md"] },
          async getItem(key) { return { key, content: key } },
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    await store.writeFile("user.md", { path: "user.md", content: "keep" })
    await createWorkspaceSourceView(definition, store).materializeSources({ sources: ["docs"] })
    keys = ["current.md"]
    const view = createWorkspaceSourceView({ ...definition }, store)
    const prefix = mount ? `${mount}/` : ""

    const entries = await view.list("", { recursive: true })

    expect(entries).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: `${prefix}stale.md` })]))
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `${prefix}current.md`, type: "file" }),
      expect.objectContaining({ path: "user.md", type: "file" }),
      expect.objectContaining({ path: "pending", type: "directory" }),
    ]))
    await expect(store.readFile(`${prefix}stale.md`)).resolves.toBeUndefined()
  })

  it.each([false, true])("reports mount stat errors per Source while materializing other Sources (cached: %s)", async (cached) => {
    const root = await createRoot()
    const store = createLocalWorkspaceStore(root)
    const definition = {
      name: "startup-mount-stat-error",
      sources: {
        healthy: custom({ materialize: "startup" as const, mount: "healthy", files: [{ path: "ok.md", content: "ready" }] }),
        blocked: custom({ cache: cached ? { maxAge: 60_000 } : undefined, materialize: "startup" as const, mount: "parent/docs", files: [] }),
      },
    }
    await createWorkspaceSourceView(definition, store).materializeSources({ sources: ["blocked"] })
    await rm(join(root, "parent"), { recursive: true })
    await writeFile(join(root, "parent"), "user replacement")

    const result = await createWorkspaceSourceView({ ...definition }, store).materializeSources()

    expect(result.sources).toEqual([
      expect.objectContaining({ source: "blocked", status: "error", error: expect.stringContaining("ENOTDIR") }),
      expect.objectContaining({ source: "healthy", status: "ready" }),
    ])
    expect(await readFile(join(root, "healthy/ok.md"), "utf8")).toBe("ready")
    expect(await readFile(join(root, "parent"), "utf8")).toBe("user replacement")
  })

  it.each(["stat", "exists"] as const)("refreshes root startup Sources before the first %s", async (operation) => {
    for (const reuseStartupSnapshots of [false, true]) {
      for (const removed of [false, true]) {
        const store = createMemoryWorkspaceStore()
        let content = "old"
        let keys = ["AGENTS.md"]
        const definition = {
          name: "startup-root-metadata",
          sources: {
            instructions: custom({
              materialize: "startup" as const,
              mount: "",
              async getKeys() { return keys },
              async getItem(key) { return { key, content } },
            }),
          },
        }
        await createWorkspaceSourceView(definition, store).materializeSources({ sources: ["instructions"] })
        content = "updated instructions"
        if (removed) keys = []
        const view = createWorkspaceSourceView({ ...definition }, store, { reuseStartupSnapshots })

        if (operation === "stat") {
          if (removed && !reuseStartupSnapshots) {
            await expect(view.stat("AGENTS.md")).rejects.toThrow("does not exist")
          }
          else {
            await expect(view.stat("AGENTS.md")).resolves.toMatchObject({
              size: reuseStartupSnapshots ? 3 : content.length,
            })
          }
        }
        else {
          await expect(view.exists("AGENTS.md")).resolves.toBe(reuseStartupSnapshots || !removed)
        }
        await expect(store.readFile("AGENTS.md")).resolves.toEqual(
          removed && !reuseStartupSnapshots
            ? undefined
            : expect.objectContaining({ content: reuseStartupSnapshots ? "old" : content }),
        )
      }
    }
  })

  it.each(["prepare", "mkdir", "list"].flatMap(stage => [false, true].map(local => ({ stage, local }))))("claims a failed startup mount only after creation at $stage with local=$local", async ({ stage, local }) => {
    const root = await createRoot()
    const store = local ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    const definition = {
      name: "failed-startup-mount",
      sources: {
        docs: custom({
          materialize: "startup",
          async prepare() {
            if (stage === "prepare") throw new Error("prepare failed")
          },
          async getKeys() { throw new Error("list failed") },
          async getItem(key) { return { key, content: key } },
        }),
      },
    }
    if (stage === "mkdir") vi.spyOn(store, "mkdir").mockRejectedValueOnce(new Error("mkdir failed"))
    await expect(createWorkspaceSourceView(definition, store).materializeSources()).resolves.toMatchObject({
      sources: [{ status: "error", error: `${stage} failed` }],
    })
    vi.restoreAllMocks()
    if (stage !== "list") {
      await expect(store.stat("docs")).resolves.toBeUndefined()
      await store.mkdir("docs", { recursive: true })
    }
    const reopened = local ? createLocalWorkspaceStore(root) : store
    await createWorkspaceSourceView({ name: definition.name, sources: {} }, reopened).materializeSources()
    if (stage === "list") await expect(reopened.stat("docs")).resolves.toBeUndefined()
    else await expect(reopened.stat("docs")).resolves.toMatchObject({ type: "directory" })
  })

  it.each(["abort", "write"].flatMap(stage => [false, true].map(local => ({ stage, local }))))("does not claim unwritten child directories after $stage with local=$local", async ({ stage, local }) => {
    const root = await createRoot()
    const store = local ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    const abort = new AbortController()
    const definition = {
      name: "unwritten-startup-directory",
      sources: {
        docs: custom({
          materialize: "startup",
          async getKeys() { return ["child/file.md"] },
          async getItem(key) { return { key, content: key } },
        }),
      },
    }
    if (stage === "abort") {
      const stat = store.stat.bind(store)
      vi.spyOn(store, "stat").mockImplementation(async (path) => {
        const entry = await stat(path)
        if (path === "docs/child" && !entry) abort.abort(new Error("write canceled"))
        return entry
      })
    }
    else vi.spyOn(store, "writeFile").mockRejectedValueOnce(new Error("write failed"))
    const materialization = createWorkspaceSourceView(definition, store).materializeSources({ abortSignal: abort.signal })
    if (stage === "abort") await expect(materialization).rejects.toThrow("write canceled")
    else await expect(materialization).resolves.toMatchObject({ sources: [{ status: "error", error: "write failed" }] })
    vi.restoreAllMocks()
    await expect(store.stat("docs/child")).resolves.toBeUndefined()
    await store.mkdir("docs/child", { recursive: true })
    const reopened = local ? createLocalWorkspaceStore(root) : store
    await createWorkspaceSourceView({ name: definition.name, sources: {} }, reopened).materializeSources()
    await expect(reopened.stat("docs/child")).resolves.toMatchObject({ type: "directory" })
  })

  it.each([
    { restart: false, replaceDirectory: "" },
    { restart: true, replaceDirectory: "" },
    { restart: false, replaceDirectory: "docs/child/nested" },
    { restart: true, replaceDirectory: "docs/child/nested" },
    { restart: false, replaceDirectory: "docs/child" },
    { restart: true, replaceDirectory: "docs/child" },
    { restart: false, replaceDirectory: "docs" },
    { restart: true, replaceDirectory: "docs" },
  ])("cleans failed Local Store stream directories without deleting replacements: %j", async ({ restart, replaceDirectory }) => {
    const root = await createRoot()
    const store = createLocalWorkspaceStore(root)
    const definition = {
      name: "failed-startup-stream-directories",
      sources: {
        docs: custom({
          materialize: "startup",
          async getKeys() { return ["child/nested/file.md"] },
          async getItem(key) {
            return {
              key,
              contentStream: new ReadableStream<Uint8Array>({
                pull(controller) { controller.error(new Error("stream failed")) },
              }),
            }
          },
        }),
      },
    }

    await expect(createWorkspaceSourceView(definition, store).materializeSources()).resolves.toMatchObject({
      sources: [{ status: "error", error: "stream failed" }],
    })
    await expect(store.stat("docs/child/nested")).resolves.toMatchObject({ type: "directory" })
    await expect(store.stat("docs/child/nested/file.md")).resolves.toBeUndefined()

    if (replaceDirectory) {
      await store.rm(replaceDirectory, { recursive: true })
      await store.writeFile(replaceDirectory, { path: replaceDirectory, content: "user replacement" })
    }
    const reopened = restart ? createLocalWorkspaceStore(root) : store
    await createWorkspaceSourceView({ name: definition.name, sources: {} }, reopened).materializeSources()
    if (replaceDirectory) {
      const replacement = await reopened.readFile(replaceDirectory)
      expect(replacement).toBeDefined()
      expect(typeof replacement!.content === "string" ? replacement!.content : new TextDecoder().decode(replacement!.content)).toBe("user replacement")
    }
    else {
      await expect(reopened.stat("docs")).resolves.toBeUndefined()
    }
  })

  it.each(["list", "glob", "search", "stat", "exists", "readFile"] as const)("reconciles the final removed startup Source before direct %s", async (operation) => {
    const store = createMemoryWorkspaceStore()
    const initial = createWorkspace({
      name: "final-removed-startup-source",
      store,
      sources: {
        instructions: {
          content: "# Old instructions\n",
          materialize: "startup",
          mount: "",
          workspacePath: "AGENTS.md",
        },
      },
    })
    await initial.list("", { recursive: true })
    await expect(store.readFile("AGENTS.md")).resolves.toBeDefined()
    await store.writeFile("user.md", { path: "user.md", content: "User file" })
    const workspace = createWorkspace({ name: initial.name, store, sources: {} })

    if (operation === "list") {
      await expect(workspace.list("", { recursive: true })).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ path: "AGENTS.md" })]))
    }
    else if (operation === "glob") {
      await expect(workspace.glob("**/*.md")).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ path: "AGENTS.md" })]))
    }
    else if (operation === "search") {
      await expect(workspace.search({ pattern: "Old instructions" })).resolves.toEqual([])
    }
    else if (operation === "exists") {
      await expect(workspace.exists("AGENTS.md")).resolves.toBe(false)
    }
    else {
      await expect(workspace[operation]("AGENTS.md")).rejects.toThrow("does not exist")
    }
    await expect(store.readFile("AGENTS.md")).resolves.toBeUndefined()
    await expect(store.readFile("user.md")).resolves.toMatchObject({ content: "User file" })
  })

  it("removes files owned by startup Sources removed from the definition", async () => {
    const store = createMemoryWorkspaceStore()
    const initial = {
      name: "removed-startup-sources",
      sources: {
        instructions: {
          content: "# Old instructions\n",
          materialize: "startup" as const,
          mount: "",
          workspacePath: "AGENTS.md",
        },
        oldSkill: {
          content: "# Old skill\n",
          materialize: "startup" as const,
          mount: "",
          workspacePath: ".agents/skills/old/SKILL.md",
        },
      },
    }
    await createWorkspaceSourceView(initial, store).materializeSources({ sources: ["instructions", "oldSkill"] })
    await store.writeFile("AGENTS.md", { path: "AGENTS.md", content: "# User instructions\n" })

    await createWorkspaceSourceView({
      name: initial.name,
      sources: {
        newSkill: {
          content: "# New skill\n",
          materialize: "startup" as const,
          mount: "",
          workspacePath: ".agents/skills/new/SKILL.md",
        },
      },
    }, store).materializeSources({ sources: ["newSkill"] })

    await expect(store.readFile("AGENTS.md")).resolves.toMatchObject({ content: "# User instructions\n" })
    await expect(store.stat(".agents/skills/old/SKILL.md")).resolves.toBeUndefined()
    await expect(store.stat(".agents/skills/old")).resolves.toBeUndefined()
    await expect(store.readFile(".agents/skills/new/SKILL.md")).resolves.toMatchObject({ content: "# New skill\n" })
  })

  it.each(["", "docs"].flatMap(mount => [false, true].map(restart => ({ mount, restart }))))("preserves pre-existing child directories at mount $mount with restart $restart", async ({ mount, restart }) => {
    const root = await createRoot()
    const store = restart ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    const path = (name: string) => mount ? `${mount}/${name}` : name
    await store.mkdir(path("kept"), { recursive: true })
    const initial = {
      name: "preexisting-startup-directories",
      sources: {
        docs: custom({
          materialize: "startup",
          mount,
          files: [
            { path: "kept/file.md", content: "generated" },
            { path: "created/file.md", content: "generated" },
          ],
        }),
      },
    }
    await createWorkspaceSourceView(initial, store).materializeSources()
    await createWorkspaceSourceView(initial, store).materializeSources()
    await createWorkspaceSourceView({ name: initial.name, sources: {} }, restart ? createLocalWorkspaceStore(root) : store).materializeSources()

    await expect(store.stat(path("kept"))).resolves.toMatchObject({ type: "directory" })
    await expect(store.stat(path("kept/file.md"))).resolves.toBeUndefined()
    await expect(store.stat(path("created"))).resolves.toBeUndefined()
  })

  it.each(["", "docs"].flatMap(mount => [false, true].map(restart => ({ mount, restart }))))("preserves pre-existing child directories during refresh at mount $mount with restart $restart", async ({ mount, restart }) => {
    const root = await createRoot()
    const store = restart ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    const path = (name: string) => mount ? `${mount}/${name}` : name
    await store.mkdir(path("kept"), { recursive: true })
    const initial = {
      name: "preexisting-startup-directories",
      sources: {
        docs: custom({
          materialize: "startup",
          mount,
          files: [
            { path: "kept/file.md", content: "generated" },
            { path: "created/file.md", content: "generated" },
          ],
        }),
      },
    }
    await createWorkspaceSourceView(initial, store).materializeSources()
    await createWorkspaceSourceView(initial, store).materializeSources()
    await createWorkspaceSourceView({ name: initial.name, sources: { docs: custom({ materialize: "startup", mount, files: [] }) } }, restart ? createLocalWorkspaceStore(root) : store).materializeSources()

    await expect(store.stat(path("kept"))).resolves.toMatchObject({ type: "directory" })
    await expect(store.stat(path("kept/file.md"))).resolves.toBeUndefined()
    await expect(store.stat(path("created"))).resolves.toBeUndefined()
  })

  it.each(["", "docs"])("removes unchanged startup files after a local Store restart at mount %s", async (mount) => {
    const root = await createRoot()
    const store = createLocalWorkspaceStore(root)
    const initial = {
      name: "restarted-startup-cleanup",
      sources: {
        instructions: custom({
          materialize: "startup",
          mount,
          files: [
            { path: "AGENTS.md", content: "old instructions" },
            { path: ".agents/skills/old/SKILL.md", content: "old skill" },
            { path: "edited.md", content: "original" },
            { path: "claimed.md", content: "original" },
          ],
        }),
      },
    }
    await createWorkspaceSourceView(initial, store).materializeSources()
    const path = (name: string) => mount ? `${mount}/${name}` : name
    const restarted = createLocalWorkspaceStore(root)
    await expect(restarted.readFile(path("AGENTS.md"))).resolves.toMatchObject({ metadata: undefined })
    await restarted.writeFile(path("edited.md"), { path: path("edited.md"), content: "user edit" })
    await restarted.writeFile(path("claimed.md"), { path: path("claimed.md"), content: "original", metadata: { source: "other" } })
    await syncWorkspaceDefinition({ name: initial.name, sources: {} }, restarted)

    await expect(restarted.stat(path("AGENTS.md"))).resolves.toBeUndefined()
    await expect(restarted.stat(path(".agents/skills/old"))).resolves.toBeUndefined()
    await expect(restarted.readFile(path("edited.md"))).resolves.toMatchObject({ content: expect.any(Uint8Array) })
    await expect(restarted.readFile(path("claimed.md"))).resolves.toMatchObject({ metadata: { source: "other" } })
  })

  it.each([undefined, "docs/generated"])("reconciles failed startup sources after materializing path %s", async (path) => {
    const store = createMemoryWorkspaceStore()
    const initial = {
      name: "failed-startup-source",
      sources: {
        generated: custom({
          materialize: "startup",
          mount: "docs/generated",
          async getKeys() { return ["partial.md", "unavailable.md"] },
          async getItem(key) {
            if (key === "unavailable.md") throw new Error("Source unavailable")
            return { key, content: "partial" }
          },
        }),
      },
    }
    await expect(createWorkspaceSourceView(initial, store).materializeSources({ path })).resolves.toMatchObject({
      sources: [expect.objectContaining({ status: "error" })],
    })
    await expect(store.readFile("docs/generated/partial.md")).resolves.toMatchObject({ content: "partial" })

    await syncWorkspaceDefinition({ name: initial.name, sources: {} }, store)
    await expect(store.stat("docs/generated/partial.md")).resolves.toBeUndefined()
    await expect(store.stat("docs/generated")).resolves.toBeUndefined()
  })

  it.each([
    { preexisting: false, moved: false, userFile: false },
    { preexisting: true, moved: false, userFile: false },
    { preexisting: false, moved: true, userFile: false },
    { preexisting: true, moved: true, userFile: false },
    { preexisting: false, moved: false, userFile: true },
    { preexisting: false, moved: true, userFile: true },
  ])("cleans empty startup mounts with preexisting=$preexisting moved=$moved userFile=$userFile", async ({ preexisting, moved, userFile }) => {
    const store = createMemoryWorkspaceStore()
    if (preexisting) await store.mkdir("docs/generated", { recursive: true })
    const source = (mount: string) => custom({
      materialize: "startup",
      mount,
      async getKeys() { return [] },
      async getItem(key) { return { key, content: "" } },
    })
    const initial = { name: "empty-startup-mount", sources: { generated: source("docs/generated") } }
    await createWorkspaceSourceView(initial, store).materializeSources()
    // A later refresh must retain the original mount ownership.
    await createWorkspaceSourceView(initial, store).materializeSources()
    await expect(store.stat("docs/generated")).resolves.toMatchObject({ type: "directory" })
    if (userFile) await store.writeFile("docs/generated/user.md", { path: "docs/generated/user.md", content: "keep" })

    await createWorkspaceSourceView({
      name: initial.name,
      sources: moved ? { generated: source("docs/moved") } : {},
    }, store).materializeSources()

    if (userFile) await expect(store.readFile("docs/generated/user.md")).resolves.toMatchObject({ content: "keep" })
    if (preexisting || userFile) await expect(store.stat("docs/generated")).resolves.toMatchObject({ type: "directory" })
    else await expect(store.stat("docs/generated")).resolves.toBeUndefined()
    if (preexisting || userFile || moved) await expect(store.stat("docs")).resolves.toMatchObject({ type: "directory" })
    else await expect(store.stat("docs")).resolves.toBeUndefined()
    if (moved) await expect(store.stat("docs/moved")).resolves.toMatchObject({ type: "directory" })
  })

  it.each([true, false])("preserves shared empty startup mounts without current ownership evidence with snapshot reuse %s", async (reuseStartupSnapshots) => {
    const store = createMemoryWorkspaceStore()
    const source = () => custom({
      materialize: "startup",
      mount: "docs/generated",
      async getKeys() { return [] },
      async getItem(key) { return { key, content: "" } },
    })
    const retained = source()
    const initial = { name: "shared-empty-startup-mount", sources: { removed: source(), retained } }
    // Establish the removed Source as the original directory owner explicitly.
    const initialView = createWorkspaceSourceView(initial, store)
    await initialView.materializeSources({ sources: ["removed"] })
    await initialView.materializeSources({ sources: ["retained"] })
    await expect(store.getMeta?.("source:removed:snapshot")).resolves.toMatchObject({ ownsMount: true })
    await expect(store.getMeta?.("source:retained:snapshot")).resolves.toMatchObject({ ownsMount: false, status: "ready" })

    const next = { name: initial.name, sources: { retained } }
    await syncWorkspaceDefinition(next, store)
    const view = createWorkspaceSourceView(next, store, { reuseStartupSnapshots })
    await expect(view.stat("docs/generated")).resolves.toMatchObject({ type: "directory" })
    await expect(view.list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/generated", type: "directory" }),
    ]))

    await syncWorkspaceDefinition({ name: initial.name, sources: {} }, store)
    await expect(store.stat("docs/generated")).resolves.toMatchObject({ type: "directory" })
  })

  it.each([false, true])("does not transfer deleted mount ownership with local=%s", async (local) => {
    const store = local ? createLocalWorkspaceStore(await createRoot()) : createMemoryWorkspaceStore()
    const source = (path: string) => custom({ materialize: "startup", mount: "docs", files: [{ path, content: path }] })
    const retained = source("retained.md")
    const initial = { name: "deleted-mount-transfer", sources: { removed: source("removed.md"), retained } }
    const view = createWorkspaceSourceView(initial, store)
    await view.materializeSources({ sources: ["removed"] })
    await view.materializeSources({ sources: ["retained"] })

    const originalRm = store.rm.bind(store)
    const remove = vi.spyOn(store, "rm").mockImplementation(async (path, options) => {
      // The retained file disappears after descendant evidence was collected.
      if (path === "docs") await originalRm("docs/retained.md", { force: true })
      await originalRm(path, options)
    })
    await syncWorkspaceDefinition({ name: initial.name, sources: { retained } }, store)
    remove.mockRestore()
    await expect(store.stat("docs")).resolves.toBeUndefined()
    await expect(store.getMeta?.("source:retained:snapshot")).resolves.toMatchObject({ ownsMount: false })

    await store.mkdir("docs")
    await syncWorkspaceDefinition({ name: initial.name, sources: {} }, store)
    await expect(store.stat("docs")).resolves.toMatchObject({ type: "directory" })
  })

  it.each([
    { local: false, reuseStartupSnapshots: false },
    { local: false, reuseStartupSnapshots: true },
    { local: true, reuseStartupSnapshots: false },
    { local: true, reuseStartupSnapshots: true },
  ])("transfers nonempty shared mount ownership with local=$local snapshot reuse=$reuseStartupSnapshots", async ({ local, reuseStartupSnapshots }) => {
    const store = local ? createLocalWorkspaceStore(await createRoot()) : createMemoryWorkspaceStore()
    const source = (path: string) => custom({
      materialize: "startup",
      mount: "docs/generated",
      files: [{ path, content: path }],
    })
    const retained = source("retained.md")
    const initial = { name: "shared-nonempty-startup-mount", sources: { removed: source("removed.md"), retained } }
    // Establish the removed Source as the original directory owner explicitly.
    const initialView = createWorkspaceSourceView(initial, store)
    await initialView.materializeSources({ sources: ["removed"] })
    await initialView.materializeSources({ sources: ["retained"] })
    await expect(store.getMeta?.("source:removed:snapshot")).resolves.toMatchObject({ ownsMount: true })
    await expect(store.getMeta?.("source:retained:snapshot")).resolves.toMatchObject({ ownsMount: false })

    const next = { name: initial.name, sources: { retained } }
    await syncWorkspaceDefinition(next, store)
    await expect(store.stat("docs/generated/retained.md")).resolves.toMatchObject({ type: "file" })
    const view = createWorkspaceSourceView(next, store, { reuseStartupSnapshots })
    await expect(view.list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/generated/retained.md", type: "file" }),
    ]))
    await expect(view.readFile("docs/generated/retained.md")).resolves.toBe("retained.md")

    await syncWorkspaceDefinition({ name: initial.name, sources: {} }, store)
    await expect(store.stat("docs/generated")).resolves.toBeUndefined()
    await expect(store.stat("docs")).resolves.toBeUndefined()
  })

  it.each([
    { local: false, reuseStartupSnapshots: false },
    { local: false, reuseStartupSnapshots: true },
    { local: true, reuseStartupSnapshots: false },
    { local: true, reuseStartupSnapshots: true },
  ])("transfers shared child directory ownership with local=$local snapshot reuse=$reuseStartupSnapshots", async ({ local, reuseStartupSnapshots }) => {
    const root = local ? await createRoot() : undefined
    let store = root ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    await store.mkdir("docs/generated/user-created")
    const source = (files: string[]) => custom({
      materialize: "startup",
      mount: "docs/generated",
      files: files.map(path => ({ path, content: path })),
    })
    const retained = source(["nested/deep/retained.md", "user-created/retained.md"])
    const sibling = source(["sibling.md"])
    const initial = {
      name: "shared-child-startup-directory",
      sources: { removed: source(["nested/deep/removed.md"]), retained, sibling },
    }
    await createWorkspaceSourceView(initial, store).materializeSources({ sources: ["removed"] })
    await createWorkspaceSourceView(initial, store).materializeSources()

    const next = { name: initial.name, sources: { retained, sibling } }
    await syncWorkspaceDefinition(next, store)
    const view = createWorkspaceSourceView(next, store, { reuseStartupSnapshots })
    await expect(view.readFile("docs/generated/nested/deep/retained.md")).resolves.toBe("nested/deep/retained.md")
    await expect(view.readFile("docs/generated/sibling.md")).resolves.toBe("sibling.md")
    if (root) store = createLocalWorkspaceStore(root)

    await syncWorkspaceDefinition({ name: initial.name, sources: { sibling } }, store)
    await expect(store.stat("docs/generated/nested")).resolves.toBeUndefined()
    await expect(store.stat("docs/generated/sibling.md")).resolves.toMatchObject({ type: "file" })
    await expect(store.stat("docs/generated/user-created")).resolves.toMatchObject({ type: "directory" })
    await syncWorkspaceDefinition({ name: initial.name, sources: {} }, store)
    await expect(store.stat("docs/generated/user-created")).resolves.toMatchObject({ type: "directory" })
  })

  it.each([
    { local: false, reuseStartupSnapshots: false },
    { local: false, reuseStartupSnapshots: true },
    { local: true, reuseStartupSnapshots: false },
    { local: true, reuseStartupSnapshots: true },
  ])("transfers ancestor mount ownership with local=$local snapshot reuse=$reuseStartupSnapshots", async ({ local, reuseStartupSnapshots }) => {
    const root = local ? await createRoot() : undefined
    let store = root ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    const source = (mount: string) => custom({
      materialize: "startup",
      mount,
      files: [{ path: "file.md", content: mount }],
    })
    const retained = source("docs/generated")
    const sibling = source("docs/sibling")
    const initial = { name: "nested-startup-mount", sources: { removed: source("docs"), retained, sibling } }
    await createWorkspaceSourceView(initial, store).materializeSources({ sources: ["removed"] })
    await createWorkspaceSourceView(initial, store).materializeSources()

    const next = { name: initial.name, sources: { retained, sibling } }
    await syncWorkspaceDefinition(next, store)
    const view = createWorkspaceSourceView(next, store, { reuseStartupSnapshots })
    await expect(view.readFile("docs/generated/file.md")).resolves.toBe("docs/generated")
    await expect(view.readFile("docs/sibling/file.md")).resolves.toBe("docs/sibling")
    // Ownership must survive both refresh and a persistent Store restart.
    if (root) store = createLocalWorkspaceStore(root)
    await syncWorkspaceDefinition({ name: initial.name, sources: { sibling } }, store)
    await expect(store.stat("docs/generated")).resolves.toBeUndefined()
    await expect(store.stat("docs/sibling/file.md")).resolves.toMatchObject({ type: "file" })
    await syncWorkspaceDefinition({ name: initial.name, sources: {} }, store)
    await expect(store.stat("docs")).resolves.toBeUndefined()
  })

  it.each([false, true])("preserves a recreated shared directory during ownership transfer with local=%s", async (local) => {
    const store = local ? createLocalWorkspaceStore(await createRoot()) : createMemoryWorkspaceStore()
    const source = (path: string) => custom({
      materialize: "startup",
      mount: "docs",
      files: [{ path, content: path }],
    })
    const retained = source("nested/retained.md")
    const initial = { name: "recreated-transfer-directory", sources: { removed: source("nested/removed.md"), retained } }
    await createWorkspaceSourceView(initial, store).materializeSources({ sources: ["removed"] })
    await createWorkspaceSourceView(initial, store).materializeSources()
    await store.rm("docs/nested", { recursive: true })
    await store.mkdir("docs/nested")

    await syncWorkspaceDefinition({ name: initial.name, sources: { retained } }, store)
    await expect(store.stat("docs/nested")).resolves.toMatchObject({ type: "directory" })
    const snapshot = await readCurrentSourceSnapshot(store, normalizeWorkspaceSources({ retained })[0]!)
    expect(snapshot?.ownedDirectories || []).not.toContain("docs/nested")
    await syncWorkspaceDefinition({ name: initial.name, sources: {} }, store)
    await expect(store.stat("docs/nested")).resolves.toMatchObject({ type: "directory" })
  })

  it.each([true, false])("restores overlapping startup files after removing their owner with snapshot reuse %s", async (reuseStartupSnapshots) => {
    const store = createMemoryWorkspaceStore()
    const retainedKeys = vi.fn(async () => ["shared.md"])
    const retained = custom({
      cache: { maxAge: 3600 },
      materialize: "startup",
      mount: "",
      getKeys: retainedKeys,
      async getItem(key) { return { key, content: "retained" } },
    })
    const initial = {
      name: "overlapping-startup-sources",
      sources: {
        retained,
        removed: custom({
          materialize: "startup",
          mount: "",
          async getKeys() { return ["shared.md"] },
          async getItem(key) { return { key, content: "removed" } },
        }),
      },
    }
    await createWorkspaceSourceView(initial, store).materializeSources()
    await store.writeFile("shared.md", { path: "shared.md", content: "removed", metadata: { source: "removed" } })
    await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "removed" })

    const next = { name: initial.name, sources: { retained } }
    await syncWorkspaceDefinition(next, store)
    const view = createWorkspaceSourceView(next, store, { reuseStartupSnapshots })
    await expect(view.list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "shared.md", type: "file" }),
    ]))
    await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "retained" })
    expect(retainedKeys).toHaveBeenCalledTimes(2)
  })

  it.each([true, false].flatMap(oldFirst => [false, true].map(local => ({ oldFirst, local }))))("cleans both mounts after a concurrent same-key move with oldFirst=$oldFirst local=$local", async ({ oldFirst, local }) => {
    const root = await createRoot()
    let store: WorkspaceStore = local ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    const pausedSource = (mount: string) => {
      let signalStarted!: () => void
      const started = new Promise<void>((resolve) => { signalStarted = resolve })
      let release!: () => void
      const resumed = new Promise<void>((resolve) => { release = resolve })
      return {
        started,
        release: () => release(),
        source: custom({
          materialize: "startup",
          mount,
          async getKeys() { return ["file.md"] },
          async getItem(key) {
            signalStarted()
            await resumed
            return { key, content: mount }
          },
        }),
      }
    }
    const old = pausedSource("old")
    const next = pausedSource("new")
    const name = "concurrent-startup-move"
    const oldRun = createWorkspaceSourceView({ name, sources: { docs: old.source } }, store).materializeSources()
    await old.started
    const definition = { name, sources: { docs: next.source } }
    const nextRun = createWorkspaceSourceView(definition, store).materializeSources()
    await next.started
    if (oldFirst) {
      old.release()
      await oldRun
      next.release()
      await nextRun
    }
    else {
      next.release()
      await nextRun
      old.release()
      await oldRun
    }

    if (local) store = createLocalWorkspaceStore(root)
    await syncWorkspaceDefinition(definition, store)
    await expect(store.stat("old/file.md")).resolves.toBeUndefined()
    await expect(store.stat("old")).resolves.toBeUndefined()
    await expect(store.readFile("new/file.md")).resolves.toMatchObject({ content: local ? new TextEncoder().encode("new") : "new" })
    await syncWorkspaceDefinition({ name, sources: {} }, store)
    await expect(store.stat("new/file.md")).resolves.toBeUndefined()
    await expect(store.stat("new")).resolves.toBeUndefined()
  })

  it.each([false, true])("retains active startup ownership across concurrent removal with abortable sync %s", async (abortableSync) => {
    const store = createMemoryWorkspaceStore()
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    let release!: () => void
    const resumed = new Promise<void>((resolve) => { release = resolve })
    const initial = {
      name: "active-startup-removal",
      sources: {
        removed: custom({
          materialize: "startup",
          mount: "",
          async getKeys() { return ["late.md"] },
          async getItem(key) {
            signalStarted()
            await resumed
            return { key, content: "late write" }
          },
        }),
      },
    }
    const materialization = createWorkspaceSourceView(initial, store).materializeSources()
    await started
    const next = { name: initial.name, sources: {} }
    try {
      await syncWorkspaceDefinition(next, store, abortableSync ? new AbortController().signal : undefined)
    }
    finally {
      release()
    }
    await materialization
    await expect(store.readFile("late.md")).resolves.toMatchObject({ content: "late write" })

    await syncWorkspaceDefinition(next, store)
    await expect(store.stat("late.md")).resolves.toBeUndefined()
    await expect(store.getMeta!(`workspace:${initial.name}:startup-sources`)).resolves.toEqual([])
  })

  it.each([false, true])("reconciles a removed owner once during concurrent startup materialization with abortable sync %s", async (abortableSync) => {
    const store = createMemoryWorkspaceStore()
    const source = (key: string) => custom({
      materialize: "startup",
      mount: "",
      async getKeys() { return [key] },
      async getItem(key) { return { key, content: key } },
    })
    const retained = source("shared.md")
    const other = source("other.md")
    await createWorkspaceSourceView({
      name: "concurrent-startup-removal",
      sources: { retained, other, removed: source("shared.md") },
    }, store).materializeSources()
    await store.writeFile("shared.md", { path: "shared.md", content: "removed", metadata: { source: "removed" } })
    const remove = store.rm.bind(store)
    const removals = vi.spyOn(store, "rm").mockImplementation(async (path, options) => {
      // Let competing source materializations reach reconciliation before deletion.
      await new Promise(resolve => setTimeout(resolve, 0))
      await remove(path, options)
    })
    const definition = { name: "concurrent-startup-removal", sources: { retained, other } }
    const view = createWorkspaceSourceView(definition, store)

    await Promise.all([
      ...(abortableSync ? [syncWorkspaceDefinition(definition, store, new AbortController().signal)] : []),
      view.glob("**/*.md"),
    ])

    expect(removals.mock.calls.filter(([path]) => path === "shared.md")).toHaveLength(1)
    await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "shared.md" })
    await expect(store.readFile("other.md")).resolves.toMatchObject({ content: "other.md" })
  })

  it.each([true, false])("preserves removed startup history through lazy-only refresh with retained source %s", async (retainStartup) => {
    const store = createMemoryWorkspaceStore()
    const source = (materialize: "startup" | "lazy", workspacePath: string) => ({
      content: workspacePath,
      materialize,
      mount: "",
      workspacePath,
    })
    const retained = source("startup", "retained.md")
    const lazy = source("lazy", "lazy.md")
    await createWorkspaceSourceView({
      name: "lazy-refresh-startup-history",
      sources: { removed: source("startup", "removed.md"), retained, lazy },
    }, store).materializeSources()

    const next = createWorkspaceSourceView({
      name: "lazy-refresh-startup-history",
      sources: { ...(retainStartup ? { retained } : {}), lazy },
    }, store)
    await next.materializeSources({ sources: ["lazy"] })
    await expect(store.readFile("lazy.md")).resolves.toMatchObject({ content: "lazy.md" })
    await expect(store.readFile("removed.md")).resolves.toMatchObject({ content: "removed.md" })
    await expect(store.readFile("retained.md")).resolves.toMatchObject({ content: "retained.md" })
    await next.materializeSources()

    await expect(store.stat("removed.md")).resolves.toBeUndefined()
    if (retainStartup) {
      await expect(store.readFile("retained.md")).resolves.toMatchObject({ content: "retained.md" })
    }
    else {
      await expect(store.stat("retained.md")).resolves.toBeUndefined()
    }
  })

  it("removes the final startup Source and files left at a previous mount", async () => {
    const store = createMemoryWorkspaceStore()
    const source = (mount: string) => custom({
      materialize: "startup" as const,
      mount,
      async getKeys() { return ["SKILL.md"] },
      async getItem(key) { return { key, content: mount } },
    })
    await createWorkspaceSourceView({
      name: "moved-startup-source",
      sources: { skill: source(".agents/skills/old") },
    }, store).materializeSources({ sources: ["skill"] })

    await createWorkspaceSourceView({
      name: "moved-startup-source",
      sources: { skill: source(".agents/skills/new") },
    }, store).materializeSources({ sources: ["skill"] })

    await expect(store.stat(".agents/skills/old/SKILL.md")).resolves.toBeUndefined()
    await expect(store.readFile(".agents/skills/new/SKILL.md")).resolves.toMatchObject({ content: ".agents/skills/new" })

    await store.setMeta?.("workspace:moved-startup-source:startup-sources", [{ key: "skill", mountPath: ".agents/skills/old" }])
    await createWorkspaceSourceView({
      name: "moved-startup-source",
      sources: { skill: source(".agents/skills/new") },
    }, store).materializeSources({ sources: ["skill"] })
    await expect(store.readFile(".agents/skills/new/SKILL.md")).resolves.toMatchObject({ content: ".agents/skills/new" })

    await createWorkspaceSourceView({ name: "moved-startup-source", sources: {} }, store).materializeSources({ sources: [] })
    await expect(store.stat(".agents/skills/new/SKILL.md")).resolves.toBeUndefined()
  })

  it("does not let snapshot-reusing inspection suppress normal startup refresh", async () => {
    const getKeys = vi.fn(async () => ["AGENTS.md"])
    const definition = {
      name: "startup-inspection-isolation",
      sources: {
        instructions: custom({
          materialize: "startup" as const,
          mount: "",
          getKeys,
          async getItem(key: string) { return { key, content: "# Instructions\n" } },
        }),
      },
    }
    const store = createMemoryWorkspaceStore()

    await createWorkspaceSourceView(definition, store).materializeSources()
    await invalidateWorkspaceSourceMaterialization(definition, store, ["instructions"])
    await createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true }).list("", { recursive: true })
    expect(getKeys).toHaveBeenCalledOnce()

    await createWorkspaceSourceView(definition, store).list("", { recursive: true })
    expect(getKeys).toHaveBeenCalledTimes(2)
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

  it("preserves files beneath a child mount during an explicit parent refresh", async () => {
    const store = createMemoryWorkspaceStore()
    await store.writeFile("docs/generated/result.md", {
      path: "docs/generated/result.md",
      content: "# Generated\n",
    })
    const view = createWorkspaceSourceView({
      name: "explicit-parent-refresh",
      sources: {
        docs: custom({
          materialize: "lazy",
          mount: "docs",
          files: [{ path: "index.md", content: "# Docs\n" }],
          sync: { stale: "remove" },
        }),
        generated: custom({
          materialize: "startup",
          mount: "docs/generated",
          files: [{ path: "result.md", content: "# Generated\n" }],
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })

    await expect(store.readFile("docs/generated/result.md")).resolves.toMatchObject({
      content: "# Generated\n",
    })
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

  it("preserves complete aggregate totals after a partial refresh failure", async () => {
    let revision = "one"
    let failSecond = false
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({
      name: "lazy-keyed-failed-aggregates",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          async getKeys() { return ["a.md", "b.md"] },
          async getItem(key) {
            if (key === "b.md" && failSecond) throw new Error("temporary source failure")
            return { key, path: key, content: key === "a.md" ? revision : "b" }
          },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })
    revision = "three"
    failSecond = true
    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({ bytes: 6, files: 2, status: "error" })],
    })
    await expect(store.getMeta?.("source:docs:snapshot")).resolves.toMatchObject({
      bytes: 6,
      files: 2,
      status: "error",
    })
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

  it("treats a Source mount request as complete across views", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const materializing = new Promise<void>((resolve) => { started = resolve })
    const getItems = vi.fn(async () => {
      started()
      await blocked
      return [{ key: "a.md", content: "# A\n" }]
    })
    const definition = {
      name: "startup-mount-wide-coordination",
      sources: {
        docs: custom({
          materialize: "startup" as const,
          getItems,
          async getItem(key: string) { return { key, content: "# A\n" } },
          async getKeys() { return ["a.md"] },
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    const first = createWorkspaceSourceView(definition, store)
    const second = createWorkspaceSourceView(definition, store)
    const active = first.materializeSources({ path: "docs" })
    await materializing
    const read = second.readFile("docs/a.md", { encoding: "utf8" })
    await Promise.resolve()
    expect(getItems).toHaveBeenCalledOnce()

    release()
    await active
    await expect(read).resolves.toBe("# A\n")
    const third = createWorkspaceSourceView(definition, store)
    await expect(third.glob("docs/**")).resolves.toEqual([expect.objectContaining({ path: "docs/a.md" })])
    expect(getItems).toHaveBeenCalledOnce()
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
            assetsStarted()
            await assetsBlocked
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

  it("serializes path-scoped build Source materialization across views", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => { firstStarted = resolve })
    let active = 0
    let maxActive = 0
    const getItem = vi.fn(async (key: string) => {
      active++
      maxActive = Math.max(maxActive, active)
      if (getItem.mock.calls.length === 1) {
        firstStarted()
        await blocked
      }
      active--
      return { key, content: key }
    })
    const definition = {
      name: "build-path-coordination",
      sources: {
        docs: custom({
          materialize: "build" as const,
          async getKeys() { return ["a.md", "b.md"] },
          getItem,
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    const first = createWorkspaceSourceView(definition, store).materializeSources({ path: "docs/a.md" })
    await started
    const second = createWorkspaceSourceView(definition, store).materializeSources({ path: "docs/b.md" })
    await Promise.resolve()
    expect(getItem).toHaveBeenCalledOnce()

    release()
    await Promise.all([first, second])
    expect(maxActive).toBe(1)
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

  it.each(["memory", "local"])("cleans scoped startup writes after source removal on %s Stores", async (kind) => {
    const root = await createRoot()
    const store = kind === "local" ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    const definition = {
      name: "scoped-startup-removal",
      sources: {
        docs: custom({
          materialize: "startup" as const,
          files: [
            { path: "a.md", content: "A" },
            { path: "b.md", content: "B" },
            { path: "edited.md", content: "generated" },
          ],
        }),
      },
    }
    const view = createWorkspaceSourceView(definition, store)
    for (const path of ["a.md", "b.md", "edited.md"]) {
      await view.materializeSources({ path: `docs/${path}` })
    }
    await store.writeFile("docs/edited.md", { path: "docs/edited.md", content: "user edit" })
    const reopened = kind === "local" ? createLocalWorkspaceStore(root) : store
    await createWorkspaceSourceView({ name: definition.name, sources: {} }, reopened).materializeSources()

    await expect(reopened.readFile("docs/a.md")).resolves.toBeUndefined()
    await expect(reopened.readFile("docs/b.md")).resolves.toBeUndefined()
    const edited = await reopened.readFile("docs/edited.md")
    expect(edited).toBeDefined()
    expect(typeof edited!.content === "string" ? edited!.content : new TextDecoder().decode(edited!.content)).toBe("user edit")
  })

  it.each(["memory", "local"])("retains prior cleanup evidence after a scoped startup configuration change on %s Stores", async (kind) => {
    const root = await createRoot()
    const store = kind === "local" ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    const definition = {
      name: "scoped-startup-config-change",
      sources: {
        docs: {
          ...custom({
            materialize: "startup",
            files: [
              { path: "old.md", content: "old" },
              { path: "edited.md", content: "generated" },
              { path: "current.md", content: "before" },
            ],
          }),
          fingerprint: { version: 1 },
        },
      },
    }
    await createWorkspaceSourceView(definition, store).materializeSources()
    await store.writeFile("docs/edited.md", { path: "docs/edited.md", content: "user edit" })
    const changed = {
      ...definition,
      sources: {
        docs: {
          ...custom({ materialize: "startup", files: [{ path: "current.md", content: "after" }] }),
          fingerprint: { version: 2 },
        },
      },
    }
    await createWorkspaceSourceView(changed, store).materializeSources({ path: "docs/current.md" })
    await expect(store.stat("docs/old.md")).resolves.toBeDefined()
    const reopened = kind === "local" ? createLocalWorkspaceStore(root) : store
    await createWorkspaceSourceView({ name: definition.name, sources: {} }, reopened).materializeSources()

    await expect(reopened.stat("docs/old.md")).resolves.toBeUndefined()
    await expect(reopened.stat("docs/current.md")).resolves.toBeUndefined()
    const edited = await reopened.readFile("docs/edited.md")
    expect(edited).toBeDefined()
    expect(typeof edited!.content === "string" ? edited!.content : new TextDecoder().decode(edited!.content)).toBe("user edit")
  })

  it.each(["memory", "local"].flatMap(kind => [false, true].map(retry => ({ kind, retry }))))("retains cleanup evidence through failed startup configuration refreshes on $kind with retry=$retry", async ({ kind, retry }) => {
    const root = await createRoot()
    const store = kind === "local" ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    const definition = {
      name: "failed-startup-config-change",
      sources: {
        generated: {
          ...custom({
            materialize: "startup",
            mount: "",
            files: [
              { path: "old.md", content: "old" },
              { path: "edited.md", content: "generated" },
            ],
          }),
          fingerprint: { version: 1 },
        },
      },
    }
    await createWorkspaceSourceView(definition, store).materializeSources()
    await store.writeFile("edited.md", { path: "edited.md", content: "user edit" })
    let fail = true
    const changed = {
      ...definition,
      sources: {
        generated: {
          ...custom({
            materialize: "startup",
            mount: "",
            async getKeys() { return ["current.md", "last.md"] },
            async getItem(key) {
              if (fail && key === "last.md") throw new Error("Source unavailable")
              return { key, content: "new" }
            },
          }),
          fingerprint: { version: 2 },
        },
      },
    }
    await expect(createWorkspaceSourceView(changed, store).materializeSources()).resolves.toMatchObject({
      sources: [{ status: "error" }],
    })
    const reopened = kind === "local" ? createLocalWorkspaceStore(root) : store
    if (retry) {
      fail = false
      await expect(createWorkspaceSourceView(changed, reopened).materializeSources()).resolves.toMatchObject({
        sources: [{ status: "ready", files: 2, bytes: 6 }],
      })
    }
    else {
      await createWorkspaceSourceView({ name: definition.name, sources: {} }, reopened).materializeSources()
    }
    await expect(reopened.stat("old.md")).resolves.toBeUndefined()
    expect(Boolean(await reopened.stat("current.md"))).toBe(retry)
    const edited = await reopened.readFile("edited.md")
    expect(edited).toBeDefined()
    expect(typeof edited!.content === "string" ? edited!.content : new TextDecoder().decode(edited!.content)).toBe("user edit")
  })

  it("does not reuse scoped startup evidence as a complete snapshot", async () => {
    const store = createMemoryWorkspaceStore()
    const definition = {
      name: "scoped-startup-reuse",
      sources: {
        docs: custom({
          cache: { maxAge: 3600 },
          materialize: "startup" as const,
          files: [{ path: "a.md", content: "A" }, { path: "b.md", content: "B" }],
        }),
      },
    }
    await createWorkspaceSourceView(definition, store).materializeSources({ path: "docs/a.md" })
    await expect(store.readFile("docs/b.md")).resolves.toBeUndefined()

    const view = createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true })
    await expect(view.readFile("docs/b.md")).resolves.toBe("B")
    await expect(store.readFile("docs/a.md")).resolves.toMatchObject({ content: "A" })
  })

  it("cleans completed scoped startup writes after cancellation", async () => {
    const store = createMemoryWorkspaceStore()
    const abort = new AbortController()
    const view = createWorkspaceSourceView({
      name: "scoped-startup-cancel",
      sources: {
        docs: custom({
          materialize: "startup",
          async getKeys() { return ["sub/a.md", "sub/b.md"] },
          async getItem(key) {
            if (key === "sub/b.md") {
              abort.abort(new Error("Canceled"))
              abort.signal.throwIfAborted()
            }
            return { key, content: key }
          },
        }),
      },
    }, store)
    await expect(view.materializeSources({ path: "docs/sub", abortSignal: abort.signal })).rejects.toThrow("Canceled")
    await expect(store.readFile("docs/sub/a.md")).resolves.toMatchObject({ content: "sub/a.md" })

    await createWorkspaceSourceView({ name: "scoped-startup-cancel", sources: {} }, store).materializeSources()
    await expect(store.readFile("docs/sub/a.md")).resolves.toBeUndefined()
  })

  it("keeps cache-hit aggregates after scoped materialization", async () => {
    const files = new Map([["a.md", "# A\n"]])
    const view = createWorkspaceSourceView({
      name: "materialization-scoped-cache",
      sources: {
        docs: custom({
          cache: { maxAge: 3600 },
          materialize: "lazy",
          async getKeys() { return [...files.keys()] },
          async getItem(key) { return { key, path: key, content: files.get(key) || "" } },
        }),
      },
    }, createMemoryWorkspaceStore())

    await view.materializeSources({ sources: ["docs"] })
    files.set("b.md", "# B\n")
    await expect(view.materializeSources({ path: "docs/b.md", sources: ["docs"] })).resolves.toMatchObject({ bytes: 4, files: 1 })

    const progress: unknown[] = []
    await expect(view.materializeSources({
      details: "paths",
      onProgress(event) { progress.push(event) },
      sources: ["docs"],
    })).resolves.toMatchObject({
      bytes: 8,
      files: 2,
      sources: [{
        bytes: 8,
        counts: { added: 0, removed: 0, unchanged: 2, updated: 0 },
        files: 2,
        paths: [
          { path: "docs/a.md", status: "unchanged" },
          { path: "docs/b.md", status: "unchanged" },
        ],
      }],
    })
    expect(progress.at(-1)).toMatchObject({ bytes: 8, files: 2, status: "completed" })
  })

  it("counts streamed bytes when the Store omits size", async () => {
    const store = createLocalWorkspaceStore(await createRoot())
    const writeFileStream = store.writeFileStream!.bind(store)
    store.writeFileStream = async (path, file) => {
      const result = await writeFileStream(path, file)
      return { ...result, size: undefined }
    }
    const view = createWorkspaceSourceView({
      name: "lazy-stream-size",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          async getKeys() { return ["asset.bin"] },
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
    const readFile = vi.spyOn(store, "readFile")
    await expect(view.materializeSources({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      bytes: 5,
      sources: [{
        bytes: 5,
        counts: { added: 0, removed: 0, unchanged: 1, updated: 0 },
        paths: [{ path: "docs/asset.bin", status: "unchanged" }],
      }],
    })
    expect(readFile).not.toHaveBeenCalled()
  })

  it("cleans streamed startup files after restart with a Store-native digest", async () => {
    const root = await createRoot()
    const store = createLocalWorkspaceStore(root)
    const writeFileStream = store.writeFileStream!.bind(store)
    store.writeFileStream = async (path, file) => ({
      ...await writeFileStream(path, file),
      digest: "native-store-digest",
    })
    const definition = {
      name: "startup-stream-native-digest",
      sources: {
        docs: custom({
          materialize: "startup",
          async getKeys() { return ["stale.md", "edited.md"] },
          async getItem(key) { return { key, contentStream: new Blob(["generated"]).stream() } },
        }),
      },
    } satisfies import("../src/core/types.ts").WorkspaceDefinition
    await syncWorkspaceDefinition(definition, store)
    await createWorkspaceSourceView(definition, store).materializeSources()

    await expect(store.stat("docs/stale.md")).resolves.toMatchObject({ type: "file" })

    const restarted = createLocalWorkspaceStore(root)
    await restarted.writeFile("docs/edited.md", { path: "docs/edited.md", content: "user edit" })
    await syncWorkspaceDefinition({ name: definition.name, sources: {} }, restarted)

    await expect(restarted.stat("docs/stale.md")).resolves.toBeUndefined()
    await expect(createWorkspaceSourceView({ name: definition.name }, restarted).readFile("docs/edited.md")).resolves.toBe("user edit")
  })

  it("rejects streaming Stores that omit the required digest", async () => {
    const store = createLocalWorkspaceStore(await createRoot())
    const writeFileStream = store.writeFileStream!.bind(store)
    store.writeFileStream = async (path, file) => {
      const { digest: _, ...result } = await writeFileStream(path, file)
      // SAFETY: This fixture deliberately removes the required digest to exercise runtime validation.
      return result as Awaited<ReturnType<NonNullable<WorkspaceStore["writeFileStream"]>>>
    }
    const view = createWorkspaceSourceView({
      name: "lazy-stream-digest",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy",
          async getKeys() { return ["asset.bin"] },
          async getItem(key) {
            return { key, contentStream: new Blob(["content"]).stream() }
          },
        }),
      },
    }, store)

    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [{ error: "[vitehub] Workspace Store writeFileStream() must return a content digest.", status: "error" }],
    })
  })

  it("keeps scoped bytes aligned with the persisted snapshot after Store drift", async () => {
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({
      name: "materialization-scoped-byte-drift",
      sources: {
        docs: custom({
          cache: { maxAge: 3600 },
          materialize: "lazy",
          async getKeys() { return ["a.md"] },
          async getItem(key) { return { key, content: "# A\n" } },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })
    await store.rm("docs/a.md")
    await expect(view.materializeSources({ path: "docs/a.md", sources: ["docs"] })).resolves.toMatchObject({ bytes: 4, files: 1 })
    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      bytes: 4,
      files: 1,
      sources: [{ bytes: 4, files: 1 }],
    })
  })

  it("reports materialized file attribute changes as updates", async () => {
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
          async getKeys() { return ["a.md"] },
          async getItem(key) { return { key, path: key, content: "# Same\n", mediaType, metadata } },
        }),
      },
    }, store)

    await view.materializeSources({ sources: ["docs"] })
    mediaType = "text/markdown"
    await expect(view.materializeSources({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      sources: [{ counts: { added: 0, removed: 0, unchanged: 0, updated: 1 } }],
    })
    metadata = { category: "published" }
    await expect(view.materializeSources({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      sources: [{ counts: { added: 0, removed: 0, unchanged: 0, updated: 1 } }],
    })
    await expect(view.materializeSources({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      sources: [{ counts: { added: 0, removed: 0, unchanged: 1, updated: 0 } }],
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

  it.each([
    { local: false, preexisting: false },
    { local: true, preexisting: false },
    { local: false, preexisting: true },
    { local: true, preexisting: true },
  ])("cleans created mount ancestors with local=$local and preexisting parent=$preexisting", async ({ local, preexisting }) => {
    const store = local ? createLocalWorkspaceStore(await createRoot()) : createMemoryWorkspaceStore()
    if (preexisting) await store.mkdir("docs")
    const definition = {
      name: "nested-mount-removal",
      sources: {
        generated: custom({ materialize: "startup", mount: "docs/nested/generated", files: [{ path: "file.md", content: "generated" }] }),
      },
    }
    await createWorkspaceSourceView(definition, store).materializeSources()
    await expect(store.stat("docs/nested/generated/file.md")).resolves.toMatchObject({ type: "file" })

    await createWorkspaceSourceView({ name: definition.name, sources: {} }, store).materializeSources()

    await expect(store.stat("docs/nested")).resolves.toBeUndefined()
    if (preexisting) await expect(store.stat("docs")).resolves.toMatchObject({ type: "directory" })
    else await expect(store.stat("docs")).resolves.toBeUndefined()
  })

  it.each([false, true].flatMap(local => ["docs", "docs/nested"].map(recreated => ({ local, recreated }))))("preserves recreated mount ancestors after refresh with local=$local at $recreated", async ({ local, recreated }) => {
    const store = local ? createLocalWorkspaceStore(await createRoot()) : createMemoryWorkspaceStore()
    const definition = {
      name: "recreated-mount-ancestor",
      sources: {
        generated: custom({ materialize: "startup", mount: "docs/nested/generated", files: [{ path: "file.md", content: "generated" }] }),
      },
    }
    await createWorkspaceSourceView(definition, store).materializeSources()
    await store.rm("docs", { recursive: true })
    await store.mkdir(recreated, { recursive: true })

    await createWorkspaceSourceView({ ...definition }, store).materializeSources()
    await expect(store.stat("docs/nested/generated/file.md")).resolves.toMatchObject({ type: "file" })
    await createWorkspaceSourceView({ name: definition.name, sources: {} }, store).materializeSources()

    await expect(store.stat(recreated)).resolves.toMatchObject({ type: "directory" })
    await expect(store.stat("docs/nested/generated")).resolves.toBeUndefined()
    if (recreated === "docs") await expect(store.stat("docs/nested")).resolves.toBeUndefined()
  })

  it.each([false, true].flatMap(local => ["unchanged", "empty", "edited", "claimed"].map(replacement => ({ local, replacement }))))("revalidates retained child directories with local=$local and replacement=$replacement", async ({ local, replacement }) => {
    const store = local ? createLocalWorkspaceStore(await createRoot()) : createMemoryWorkspaceStore()
    const definition = {
      name: "recreated-child-directory",
      sources: { generated: custom({ materialize: "startup", mount: "docs", files: [{ path: "child/file.md", content: "generated" }] }) },
    }
    await createWorkspaceSourceView(definition, store).materializeSources()
    if (replacement !== "unchanged") {
      await store.rm("docs/child", { recursive: true })
      await store.mkdir("docs/child")
      if (replacement !== "empty") {
        await store.writeFile("docs/child/file.md", {
          path: "docs/child/file.md",
          content: replacement === "edited" ? "user replacement" : "generated",
          ...(replacement === "claimed" ? { metadata: { source: "other" } } : {}),
        })
      }
    }

    await createWorkspaceSourceView(definition, store).materializeSources()
    await expect(store.stat("docs/child/file.md")).resolves.toMatchObject({ type: "file" })
    await createWorkspaceSourceView({ name: definition.name, sources: {} }, store).materializeSources()

    await expect(store.stat("docs/child/file.md")).resolves.toBeUndefined()
    if (replacement !== "unchanged") await expect(store.stat("docs/child")).resolves.toMatchObject({ type: "directory" })
    else await expect(store.stat("docs/child")).resolves.toBeUndefined()
  })

  it("cleans mount ancestors created before recursive mkdir fails", async () => {
    const store = createMemoryWorkspaceStore()
    const mkdir = store.mkdir.bind(store)
    const failure = vi.spyOn(store, "mkdir").mockImplementationOnce(async () => {
      await mkdir("docs/nested", { recursive: true })
      throw new Error("mount creation failed")
    })
    const definition = {
      name: "failed-nested-mount",
      sources: { generated: custom({ materialize: "startup", mount: "docs/nested/generated", files: [] }) },
    }
    const result = await createWorkspaceSourceView(definition, store).materializeSources()
    expect(result.sources[0]?.status).toBe("error")
    await expect(store.stat("docs/nested")).resolves.toMatchObject({ type: "directory" })
    failure.mockRestore()

    await createWorkspaceSourceView({ name: definition.name, sources: {} }, store).materializeSources()
    await expect(store.stat("docs")).resolves.toBeUndefined()
  })

  it("keeps user-owned ancestors when clearing a nested source mount", async () => {
    const store = createMemoryWorkspaceStore()
    await store.mkdir("docs")
    let keys = ["nested/stale.md"]
    const view = createWorkspaceSourceView({
      name: "nested-source-cleanup",
      sources: {
        generated: custom({
          materialize: "startup",
          mount: "docs/generated",
          async getKeys() { return keys },
          async getItem(key) { return { key, path: key, content: key } },
        }),
      },
    }, store)
    await view.materializeSources()
    await expect(store.stat("docs/generated/nested/stale.md")).resolves.toMatchObject({ type: "file" })

    keys = []
    await view.materializeSources()

    await expect(store.stat("docs/generated/nested/stale.md")).resolves.toBeUndefined()
    await expect(store.stat("docs/generated")).resolves.toBeUndefined()
    await expect(store.stat("docs")).resolves.toMatchObject({ type: "directory" })
  })

  it.each([false, true])("preserves a pre-existing mount during refresh with local Store %s", async (local) => {
    const store = local ? createLocalWorkspaceStore(await createRoot()) : createMemoryWorkspaceStore()
    await store.mkdir("docs/generated", { recursive: true })
    let keys = ["stale.md"]
    const view = createWorkspaceSourceView({
      name: "preexisting-refresh-directories",
      sources: {
        generated: custom({
          materialize: "startup",
          mount: "docs/generated",
          async getKeys() { return keys },
          async getItem(key) { return { key, path: key, content: key } },
        }),
      },
    }, store)
    await view.materializeSources()
    keys = []
    await view.materializeSources()

    await expect(store.stat("docs/generated/stale.md")).resolves.toBeUndefined()
    await expect(store.stat("docs/generated")).resolves.toMatchObject({ type: "directory" })
  })

  it.each([false, true])("relinquishes directories deleted during refresh with local Store %s", async (local) => {
    const root = await createRoot()
    const store = local ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    let keys = ["nested/stale.md"]
    const definition = {
      name: "deleted-refresh-directories",
      sources: {
        generated: custom({
          materialize: "startup",
          mount: "docs/generated",
          async getKeys() { return keys },
          async getItem(key) { return { key, path: key, content: key } },
        }),
      },
    }
    const view = createWorkspaceSourceView(definition, store)
    await view.materializeSources()
    keys = []
    await view.materializeSources()

    await expect(store.stat("docs/generated")).resolves.toBeUndefined()
    await expect(store.getMeta?.("source:generated:snapshot")).resolves.toMatchObject({
      ownsMount: false,
      ownedDirectories: [],
    })
    await store.mkdir("docs/generated/nested", { recursive: true })
    const restarted = local ? createLocalWorkspaceStore(root) : store
    await syncWorkspaceDefinition({ name: definition.name, sources: {} }, restarted)

    await expect(restarted.stat("docs/generated")).resolves.toMatchObject({ type: "directory" })
    await expect(restarted.stat("docs/generated/nested")).resolves.toMatchObject({ type: "directory" })
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

  it.each(["getMeta", "setMeta", "both"] as const)("cleans owned root files without %s snapshot support", async (missing) => {
    const store: WorkspaceStore = createMemoryWorkspaceStore()
    if (missing === "getMeta" || missing === "both") store.getMeta = undefined
    if (missing === "setMeta" || missing === "both") store.setMeta = undefined
    let keys = ["AGENTS.md", "nested/stale.md"]
    const definition = {
      name: "root-without-snapshot",
      sources: {
        rootFiles: custom({
          materialize: "startup",
          mount: "",
          async getKeys() { return keys },
          async getItem(key) { return { key, path: key, content: key } },
        }),
      },
    }
    await store.writeFile("user.md", { path: "user.md", content: "user content" })
    await store.writeFile("other.md", { path: "other.md", content: "other source", metadata: { source: "other" } })
    await createWorkspaceSourceView(definition, store).materializeSources()
    keys = ["AGENTS.md"]

    await createWorkspaceSourceView(definition, store).materializeSources()

    await expect(store.stat("nested/stale.md")).resolves.toBeUndefined()
    await expect(store.stat("nested")).resolves.toBeUndefined()
    await expect(store.readFile("AGENTS.md")).resolves.toMatchObject({ content: "AGENTS.md" })
    await expect(store.readFile("user.md")).resolves.toMatchObject({ content: "user content" })
    await expect(store.readFile("other.md")).resolves.toMatchObject({ content: "other source" })
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

  it.each([false, true].flatMap(reuseStartupSnapshots => ["", "docs"].map(mount => ({ reuseStartupSnapshots, mount }))))("refreshes startup files before first search at '$mount' with snapshot reuse=$reuseStartupSnapshots", async ({ reuseStartupSnapshots, mount }) => {
    const store = createMemoryWorkspaceStore()
    let keys = ["deleted.md", "changed.md"]
    let content = "old needle"
    const definition = {
      name: "startup-search-refresh",
      sources: {
        docs: custom({
          mount,
          materialize: "startup" as const,
          async getKeys() { return keys },
          async getItem(key) { return { key, content } },
        }),
      },
    }
    await createWorkspaceSourceView(definition, store).materializeSources()
    keys = ["changed.md"]
    content = "new needle"
    const view = createWorkspaceSourceView({ ...definition }, store, { reuseStartupSnapshots })

    const hits = await view.search({ pattern: "needle", limit: 1 })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ text: reuseStartupSnapshots ? "old needle" : "new needle" })
    if (!reuseStartupSnapshots) {
      expect(hits[0]?.path).toBe(mount ? `${mount}/changed.md` : "changed.md")
      await expect(view.search({ pattern: "old needle" })).resolves.toEqual([])
    }
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

  it("refreshes expired cached materialization across Workspace facades", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-05T12:00:00Z"))
    const getItem = vi.fn(async (key: string) => ({
      key,
      content: `version ${getItem.mock.calls.length}\n`,
    }))
    const definition = {
      name: "lazy-cache-expiry",
      sources: {
        docs: custom({
          cache: { maxAge: 60 },
          materialize: "lazy",
          async getKeys() { return ["foo.md"] },
          getItem,
        }),
      },
    }
    const store = createMemoryWorkspaceStore()

    await expect(createWorkspaceSourceView(definition, store).readFile("docs/foo.md"))
      .resolves.toBe("version 1\n")
    vi.setSystemTime(new Date("2026-05-05T12:02:00Z"))
    await expect(createWorkspaceSourceView(definition, store).readFile("docs/foo.md"))
      .resolves.toBe("version 2\n")
    expect(getItem).toHaveBeenCalledTimes(2)
  })

  it("retries a failed expired cache refresh before serving its partial snapshot", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-05T12:00:00Z"))
    let version = 1
    let failRefresh = false
    const getItem = vi.fn(async (key: string) => {
      if (key === "b.md" && failRefresh) throw new Error("refresh failed")
      return { key, content: `version ${version}\n` }
    })
    const definition = {
      name: "lazy-cache-failed-refresh",
      sources: {
        docs: custom({
          cache: { maxAge: 60 },
          materialize: "lazy",
          async getKeys() { return ["a.md", "b.md"] },
          getItem,
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView(definition, store)

    await expect(view.readFile("docs/a.md")).resolves.toBe("version 1\n")
    vi.setSystemTime(new Date("2026-05-05T12:02:00Z"))
    version = 2
    failRefresh = true
    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({ status: "error" })],
    })

    version = 3
    failRefresh = false
    await expect(view.readFile("docs/a.md")).resolves.toBe("version 3\n")
    expect(getItem).toHaveBeenCalledTimes(6)
  })

  it("looks up live files without enumerating the Source tree", async () => {
    const paths: Record<string, string> = { "docs/guides/start.md": "/local/start.md" }
    const ownKeys = vi.fn((target: Record<string, string>) => Reflect.ownKeys(target))
    const getItem = vi.fn(async (key: string) => ({ key, content: "unused" }))
    const source = markLiveWorkspaceSource(custom({
      materialize: "lazy",
      async getKeys() { return ["guides/start.md"] },
      getItem,
    }), new Proxy(paths, { ownKeys }))
    const view = createWorkspaceSourceView({ name: "live-stat", sources: { docs: source } }, createMemoryWorkspaceStore())

    await expect(view.stat("docs/guides/start.md")).resolves.toEqual({ path: "docs/guides/start.md", type: "file" })
    await expect(view.exists("docs/guides/start.md")).resolves.toBe(true)
    expect(ownKeys).not.toHaveBeenCalled()
    await expect(view.stat("docs/guides")).resolves.toEqual({ path: "docs/guides", type: "directory" })
    await expect(view.exists("docs/guide")).resolves.toBe(false)
    await expect(view.exists("docs/toString")).resolves.toBe(false)
    await expect(view.stat("docs/missing.md")).rejects.toThrow("Workspace path does not exist")

    delete paths["docs/guides/start.md"]
    paths["docs/reference/api.md"] = "/local/api.md"
    await expect(view.exists("docs/guides/start.md")).resolves.toBe(false)
    await expect(view.exists("docs/guides")).resolves.toBe(false)
    await expect(view.stat("docs/reference/api.md")).resolves.toEqual({ path: "docs/reference/api.md", type: "file" })
    await expect(view.stat("docs/reference")).resolves.toEqual({ path: "docs/reference", type: "directory" })
    expect(getItem).not.toHaveBeenCalled()
  })

  it("looks up live paths populated during preparation", async () => {
    const paths: Record<string, string> = {}
    const source = markLiveWorkspaceSource(custom({
      materialize: "lazy",
      async prepare() { paths["docs/ready.md"] = "/local/ready.md" },
      async getKeys() { return ["ready.md"] },
      async getItem(key) { return { key, content: "unused" } },
    }), paths)
    const view = createWorkspaceSourceView({ name: "prepared-live-stat", sources: { docs: source } }, createMemoryWorkspaceStore())
    await expect(view.stat("docs/ready.md")).resolves.toEqual({ path: "docs/ready.md", type: "file" })
    await expect(view.stat("docs")).resolves.toEqual({ path: "docs", type: "directory" })
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

  it.each(["stat", "exists", "list", "glob", "search"] as const)("recovers missing empty cached startup mounts for %s", async (operation) => {
    const getKeys = vi.fn(async () => [])
    const definition = {
      name: "startup-empty-mount-recovery",
      sources: { docs: custom({ materialize: "startup", cache: { maxAge: 3600 }, getKeys, async getItem(key) { return { key, content: "" } } }) },
    }
    const store = createMemoryWorkspaceStore()
    await createWorkspaceSourceView(definition, store).materializeSources()
    await store.rm("docs")
    const view = createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true })

    if (operation === "search") await view.search({ pattern: "ready" })
    else if (operation === "glob") await view.glob("**/*")
    else if (operation === "list") await view.list()
    else {
      const result = await view[operation]("docs")
      expect(result).toEqual(operation === "exists" ? true : expect.objectContaining({ type: "directory" }))
    }
    await expect(store.stat("docs")).resolves.toMatchObject({ type: "directory" })
    expect(getKeys).toHaveBeenCalledTimes(2)
  })

  it.each(["readFile", "stat", "exists"] as const)("recovers missing persisted startup paths for %s", async (operation) => {
    const getKeys = vi.fn(async () => ["ready.md"])
    const definition = {
      name: "startup-point-recovery",
      sources: { docs: custom({ materialize: "startup", cache: { maxAge: 3600 }, getKeys, async getItem(key) { return { key, content: "ready" } } }) },
    }
    const store = createMemoryWorkspaceStore()
    await createWorkspaceSourceView(definition, store).materializeSources()
    await store.rm("docs/ready.md")
    const view = createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true })

    const result = await view[operation]("docs/ready.md")
    expect(result).toEqual(operation === "readFile" ? "ready" : operation === "exists" ? true : expect.objectContaining({ type: "file" }))
    expect(getKeys).toHaveBeenCalledTimes(2)
  })

  it.each(["readFile", "stat", "exists"] as const)("does not refresh unknown startup paths for %s", async (operation) => {
    const getKeys = vi.fn(async () => ["ready.md"])
    const definition = {
      name: "startup-point-unknown",
      sources: { docs: custom({ materialize: "startup", getKeys, async getItem(key) { return { key, content: "ready" } } }) },
    }
    const store = createMemoryWorkspaceStore()
    await createWorkspaceSourceView(definition, store).materializeSources()
    getKeys.mockResolvedValue(["ready.md", "unknown.md"])
    const view = createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true })

    if (operation === "exists") await expect(view.exists("docs/unknown.md")).resolves.toBe(false)
    else await expect(view[operation]("docs/unknown.md")).rejects.toThrow("does not exist")
    expect(getKeys).toHaveBeenCalledOnce()
  })

  it.each(["readFile", "stat", "exists"] as const)("does not expose overlapping content after failed startup %s recovery", async (operation) => {
    const store = createMemoryWorkspaceStore()
    const getKeys = vi.fn(async () => ["ready.md"])
    const definition = {
      name: "startup-point-failure",
      sources: { docs: custom({ materialize: "startup", getKeys, async getItem(key) { return { key, content: "higher priority" } } }) },
    }
    await createWorkspaceSourceView(definition, store).materializeSources()
    await store.rm("docs/ready.md")
    getKeys.mockImplementation(async () => {
      await store.writeFile("docs/ready.md", { path: "docs/ready.md", content: "lower priority", metadata: { source: "other" } })
      throw new Error("provider unavailable")
    })
    const view = createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true })

    if (operation === "exists") await expect(view.exists("docs/ready.md")).resolves.toBe(false)
    else await expect(view[operation]("docs/ready.md")).rejects.toThrow("does not exist")
    expect(getKeys).toHaveBeenCalledTimes(2)
  })

  it("materializes startup Sources before stat and exists trust stored paths", async () => {
    const getKeys = vi.fn(async (): Promise<string[]> => [])
    const definition = {
      name: "startup-stale-stat",
      sources: {
        docs: custom({
          materialize: "startup" as const,
          getKeys,
          async getItem(key) { return { key, content: "unused" } },
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    await store.writeFile("docs/stale.md", { content: "stale", path: "docs/stale.md" })
    const view = createWorkspaceSourceView(definition, store)

    await view.materializeSources({ sources: ["docs"] })
    getKeys.mockRejectedValue(new Error("provider unavailable"))
    await expect(view.exists("docs/stale.md")).resolves.toBe(false)
    await expect(view.stat("docs/stale.md")).rejects.toThrow("Workspace path does not exist")
    expect(getKeys).toHaveBeenCalledOnce()
  })

  it("rematerializes a nested startup Source after build synchronization resets its mount", async () => {
    const getItem = vi.fn(async (key: string) => ({ key, content: `version ${getItem.mock.calls.length}\n` }))
    const definition = {
      name: "startup-nested-build-reset",
      sources: {
        docs: custom({
          materialize: "build" as const,
          mount: "docs",
          files: [{ path: "index.md", content: "# Docs\n" }],
        }),
        generated: custom({
          materialize: "startup" as const,
          mount: "docs/generated",
          async getKeys() {
            return ["result.md"]
          },
          getItem,
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView(definition, store)

    await view.materializeSources({ sources: ["generated"] })
    await syncWorkspaceDefinition(definition, store, new AbortController().signal)

    await expect(view.readFile("docs/generated/result.md")).resolves.toBe("version 2\n")
    expect(getItem).toHaveBeenCalledTimes(2)
  })

  it("invalidates an empty startup snapshot before build synchronization removes its mount", async () => {
    const prepare = vi.fn(async () => {})
    const definition = {
      name: "startup-empty-build-reset",
      sources: {
        docs: custom({
          materialize: "build" as const,
          mount: "docs",
          files: [{ path: "index.md", content: "# Docs\n" }],
        }),
        generated: custom({
          materialize: "startup" as const,
          mount: "docs/generated",
          prepare,
          async getKeys(): Promise<string[]> { return [] },
          async getItem(key) { return { key, content: "unused" } },
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView(definition, store)

    await view.materializeSources({ sources: ["generated"] })
    await syncWorkspaceDefinition(definition, store)
    await view.materializeSources({ sources: ["generated"] })

    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])("reconciles removed root startup sources after build invalidation with retained startup=%s", async (retainStartup) => {
    const definition = {
      name: "removed-invalidated-startup",
      sources: {
        docs: custom({ materialize: "build", mount: "docs", files: [{ path: "index.md", content: "docs" }] }),
        generated: custom({
          materialize: "startup",
          mount: "",
          files: [
            { path: "docs/generated.md", content: "generated" },
            { path: "generated/stale.md", content: "stale" },
            { path: "replaced.md", content: "original" },
          ],
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    await createWorkspaceSourceView(definition, store).materializeSources({ sources: ["generated"] })
    await store.writeFile("replaced.md", { path: "replaced.md", content: "user replacement" })
    await store.writeFile("user.md", { path: "user.md", content: "user" })
    await syncWorkspaceDefinition(definition, store)
    await expect(store.getMeta?.("source:generated:snapshot")).resolves.toMatchObject({ status: "updating" })
    await expect(store.stat("generated/stale.md")).resolves.toBeDefined()

    await syncWorkspaceDefinition({
      name: definition.name,
      sources: retainStartup
        ? { retained: custom({ materialize: "startup", mount: "retained", files: [{ path: "index.md", content: "retained" }] }) }
        : {},
    }, store)

    await expect(store.stat("generated/stale.md")).resolves.toBeUndefined()
    await expect(store.stat("generated")).resolves.toBeUndefined()
    await expect(store.readFile("replaced.md")).resolves.toMatchObject({ content: "user replacement" })
    await expect(store.readFile("user.md")).resolves.toMatchObject({ content: "user" })
  })

  it.each([
    { buildMount: "", changeConfiguration: false },
    { buildMount: "docs", changeConfiguration: false },
    { buildMount: "", changeConfiguration: true },
    { buildMount: "docs", changeConfiguration: true },
  ])("retains startup cleanup evidence after a local restart and build invalidation at '$buildMount' with changed configuration=$changeConfiguration", async ({ buildMount, changeConfiguration }) => {
    const root = await createRoot()
    const definition = {
      name: "restarted-invalidated-startup",
      sources: {
        built: custom({ materialize: "build", mount: buildMount, files: [{ path: "shared.md", content: "build" }] }),
        generated: custom({
          materialize: "startup",
          mount: "",
          files: [
            { path: buildMount ? `${buildMount}/shared.md` : "shared.md", content: "startup" },
            { path: "generated/stale.md", content: "stale" },
            { path: "edited.md", content: "original" },
            { path: "claimed.md", content: "original" },
          ],
        }),
      },
    }
    const original = createLocalWorkspaceStore(root)
    await syncWorkspaceDefinition(definition, original)
    await createWorkspaceSourceView(definition, original).materializeSources({ sources: ["generated"] })

    const restarted = createLocalWorkspaceStore(root)
    await restarted.writeFile("edited.md", { path: "edited.md", content: "user edit" })
    await restarted.writeFile("claimed.md", { path: "claimed.md", content: "original", metadata: { source: "other" } })
    const currentDefinition = changeConfiguration
      ? {
          ...definition,
          sources: {
            ...definition.sources,
            generated: custom({ ...definition.sources.generated, fingerprint: { version: 2 } }),
          },
        }
      : definition
    await syncWorkspaceDefinition(currentDefinition, restarted)
    await expect(restarted.stat("generated/stale.md")).resolves.toBeDefined()

    await syncWorkspaceDefinition({ name: definition.name, sources: {} }, restarted)

    await expect(restarted.stat("generated/stale.md")).resolves.toBeUndefined()
    await expect(restarted.stat("generated")).resolves.toBeUndefined()
    await expect(createWorkspaceSourceView({ name: definition.name }, restarted).readFile("edited.md")).resolves.toBe("user edit")
    await expect(restarted.readFile("claimed.md")).resolves.toMatchObject({ metadata: { source: "other" } })
  })

  it.each(["", "docs"])("preserves user edits when a changed startup source at '%s' refreshes after restart", async (mount) => {
    const root = await createRoot()
    const path = (name: string) => mount ? `${mount}/${name}` : name
    const definition = {
      name: "restarted-changed-startup",
      sources: {
        generated: {
          ...custom({
            materialize: "startup",
            mount,
            files: [
              { path: "stale.md", content: "stale" },
              { path: "edited.md", content: "original" },
              { path: "claimed.md", content: "original" },
            ],
          }),
          fingerprint: { version: 1 },
        },
      },
    }
    await createWorkspaceSourceView(definition, createLocalWorkspaceStore(root)).materializeSources()
    await writeFile(join(root, path("edited.md")), "user edit")
    const restarted = createLocalWorkspaceStore(root)
    await restarted.writeFile(path("claimed.md"), { path: path("claimed.md"), content: "original", metadata: { source: "other" } })
    const currentDefinition = {
      ...definition,
      sources: {
        generated: {
          ...custom({ materialize: "startup", mount, files: [{ path: "new.md", content: "new" }] }),
          fingerprint: { version: 2 },
        },
      },
    }

    await syncWorkspaceDefinition(currentDefinition, restarted)
    await createWorkspaceSourceView(currentDefinition, restarted).materializeSources()

    await expect(restarted.stat(path("stale.md"))).resolves.toBeUndefined()
    await expect(readFile(join(root, path("edited.md")), "utf8")).resolves.toBe("user edit")
    await expect(restarted.readFile(path("claimed.md"))).resolves.toMatchObject({ metadata: { source: "other" } })
    await expect(readFile(join(root, path("new.md")), "utf8")).resolves.toBe("new")

    await createWorkspaceSourceView(currentDefinition, restarted).materializeSources()
    await expect(readFile(join(root, path("edited.md")), "utf8")).resolves.toBe("user edit")

    await syncWorkspaceDefinition({ name: definition.name, sources: {} }, restarted)
    await expect(restarted.stat(path("new.md"))).resolves.toBeUndefined()
    await expect(readFile(join(root, path("edited.md")), "utf8")).resolves.toBe("user edit")
    await expect(restarted.readFile(path("claimed.md"))).resolves.toMatchObject({ metadata: { source: "other" } })
  })

  it("removes stale root startup files after build cleanup invalidates their snapshot", async () => {
    let keys = ["docs/generated.md", "stale.md", "AGENTS.md"]
    const definition = {
      name: "startup-cleared-snapshot-cleanup",
      sources: {
        docs: custom({ materialize: "build", mount: "docs", files: [{ path: "index.md", content: "docs" }] }),
        generated: custom({
          materialize: "startup",
          mount: "",
          async getKeys() { return keys },
          async getItem(key) { return { key, content: key } },
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView(definition, store)
    await view.materializeSources({ sources: ["generated"] })
    await store.writeFile("user.md", { path: "user.md", content: "user" })
    await syncWorkspaceDefinition(definition, store)
    await expect(store.getMeta?.("source:generated:snapshot")).resolves.toMatchObject({ status: "updating" })
    await expect(store.stat("stale.md")).resolves.toBeDefined()
    keys = ["AGENTS.md"]

    await view.materializeSources({ sources: ["generated"] })

    await expect(store.stat("stale.md")).resolves.toBeUndefined()
    await expect(store.readFile("AGENTS.md")).resolves.toMatchObject({ content: "AGENTS.md" })
    await expect(store.readFile("user.md")).resolves.toMatchObject({ content: "user" })
    await expect(store.readFile("docs/index.md")).resolves.toMatchObject({ content: "docs" })
  })

  it.each([true, false])("restores startup ownership after overlapping root build writes with snapshot reuse %s", async (reuseStartupSnapshots) => {
    const definition = {
      name: "startup-overlapping-root-build",
      sources: {
        built: custom({ materialize: "build", mount: "", files: [{ path: "shared.md", content: "build" }] }),
        generated: custom({ materialize: "startup", mount: "", files: [{ path: "shared.md", content: "startup" }] }),
      },
    }
    const store = createMemoryWorkspaceStore()
    await createWorkspaceSourceView(definition, store).materializeSources()
    await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "startup" })

    await syncWorkspaceDefinition(definition, store)
    await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "build" })

    const inspection = createWorkspaceSourceView(definition, store, { reuseStartupSnapshots })
    await expect(inspection.readFile("shared.md")).resolves.toBe("startup")
    await expect(store.readFile("shared.md")).resolves.toMatchObject({ metadata: { source: "generated" } })
  })

  it.each(["error", "updating"] as const)("restores startup files overwritten by build sync from a %s snapshot", async (status) => {
    let fail = true
    const definition = {
      name: "startup-failed-build-overwrite",
      sources: {
        built: custom({ materialize: "build", mount: "", files: [{ path: "shared.md", content: "build" }] }),
        generated: custom({
          materialize: "startup",
          mount: "",
          async getKeys() { return ["shared.md", "retained.md", "last.md"] },
          async getMeta() { return { ref: "unchanged" } },
          async getItem(key) {
            if (key === "last.md" && fail) throw new Error("startup failed")
            return { key, content: "startup" }
          },
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    await createWorkspaceSourceView(definition, store).materializeSources({ sources: ["generated"] })
    const snapshot = await readCurrentSourceSnapshot(store, normalizeWorkspaceSource("generated", definition.sources.generated))
    expect(snapshot).toMatchObject({ status: "error", items: { "shared.md": {}, "retained.md": {} } })
    if (status === "updating") await store.setMeta?.("source:generated:snapshot", { ...snapshot, status })

    await syncWorkspaceDefinition(definition, store)
    await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "build" })
    fail = false
    await createWorkspaceSourceView(definition, store).materializeSources({ sources: ["generated"] })

    await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "startup", metadata: { source: "generated" } })
    await createWorkspaceSourceView({ name: definition.name, sources: {} }, store).materializeSources()
    await expect(store.stat("retained.md")).resolves.toBeUndefined()
  })

  it("preserves a disjoint root startup snapshot during root build cleanup", async () => {
    const getItem = vi.fn(async (key: string) => ({ key, content: "# Startup\n" }))
    const definition = {
      name: "startup-disjoint-root-build-reset",
      sources: {
        docs: custom({
          materialize: "build" as const,
          mount: "",
          files: [{ path: "build.md", content: "# Build\n" }],
        }),
        generated: custom({
          materialize: "startup" as const,
          mount: "",
          async getKeys() { return ["startup.md"] },
          getItem,
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView(definition, store)

    await view.materializeSources({ sources: ["generated"] })
    getItem.mockRejectedValue(new Error("provider unavailable"))
    await syncWorkspaceDefinition(definition, store)

    await expect(view.readFile("startup.md")).resolves.toBe("# Startup\n")
    expect(getItem).toHaveBeenCalledOnce()
  })

  it("preserves a disjoint root startup snapshot during nested build cleanup", async () => {
    const getItem = vi.fn(async (key: string) => ({ key, content: "# Startup\n" }))
    const definition = {
      name: "startup-disjoint-nested-build-reset",
      sources: {
        docs: custom({
          materialize: "build" as const,
          mount: "docs",
          files: [{ path: "index.md", content: "# Build\n" }],
        }),
        generated: custom({
          materialize: "startup" as const,
          mount: "",
          async getKeys() { return ["startup.md"] },
          getItem,
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView(definition, store)

    await view.materializeSources({ sources: ["generated"] })
    getItem.mockRejectedValue(new Error("provider unavailable"))
    await syncWorkspaceDefinition(definition, store)

    await expect(view.readFile("startup.md")).resolves.toBe("# Startup\n")
    expect(getItem).toHaveBeenCalledOnce()
  })

  it("fences pending startup materialization before build synchronization resets its mount", async () => {
    let releaseFirst!: () => void
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => { firstStarted = resolve })
    const getItem = vi.fn(async (key: string) => {
      if (getItem.mock.calls.length === 1) {
        firstStarted()
        await blocked
      }
      return { key, content: `version ${getItem.mock.calls.length}\n` }
    })
    const definition = {
      name: "startup-pending-build-reset",
      sources: {
        docs: custom({
          materialize: "build" as const,
          mount: "docs",
          files: [{ path: "index.md", content: "# Docs\n" }],
        }),
        generated: custom({
          materialize: "startup" as const,
          mount: "docs/generated",
          async getKeys() { return ["result.md"] },
          getItem,
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView(definition, store)

    const materializing = view.materializeSources({ sources: ["generated"] })
    await started
    const synchronizing = syncWorkspaceDefinition(definition, store)
    await expect(Promise.race([synchronizing.then(() => "synced"), Promise.resolve("pending")])).resolves.toBe("pending")
    releaseFirst()
    await expect(materializing).resolves.toMatchObject({
      sources: [expect.objectContaining({ source: "generated", status: "error" })],
    })
    await synchronizing

    await expect(view.readFile("docs/generated/result.md")).resolves.toBe("version 2\n")
    expect(getItem).toHaveBeenCalledTimes(2)
  })

  it("retries a startup Source after a failed full refresh", async () => {
    let version = 1
    let failRefresh = false
    const getItem = vi.fn(async (key: string) => {
      if (key === "b.md" && failRefresh) throw new Error("refresh failed")
      return { key, content: `version ${version}\n` }
    })
    const source = custom({
      materialize: "startup",
      async getKeys() {
        return ["a.md", "b.md"]
      },
      getItem,
      async getMeta() {
        return { ref: String(version) }
      },
    })
    const definition = { name: "startup-failed-refresh", sources: { docs: source } }
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView(definition, store)

    await view.materializeSources({ sources: ["docs"] })
    version = 2
    failRefresh = true
    await expect(view.materializeSources({ sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({ status: "error" })],
    })

    version = 3
    failRefresh = false
    await expect(view.readFile("docs/a.md")).resolves.toBe("version 3\n")
    expect(getItem).toHaveBeenCalledTimes(6)
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

  it("waits for an active uncached Source refresh before reading its Store", async () => {
    let releaseSecondFile!: () => void
    let markSecondFileStarted!: () => void
    const secondFileStarted = new Promise<void>((resolve) => { markSecondFileStarted = resolve })
    const secondFileReleased = new Promise<void>((resolve) => { releaseSecondFile = resolve })
    let version = 1
    const definition = {
      name: "lazy-uncached-refresh-boundary",
      sources: {
        docs: custom({
          cache: false,
          materialize: "lazy" as const,
          async getKeys() { return ["a.md", "b.md"] },
          async getItem(key) {
            if (version === 2 && key === "b.md") {
              markSecondFileStarted()
              await secondFileReleased
            }
            return { key, content: `version ${version}\n` }
          },
        }),
      },
    }
    const store = createMemoryWorkspaceStore()
    const priorView = createWorkspaceSourceView(definition, store)
    await priorView.glob("docs/*.md")

    version = 2
    const refresh = createWorkspaceSourceView(definition, store).materializeSources({ sources: ["docs"] })
    await secondFileStarted
    let readSettled = false
    const read = priorView.search({ pattern: "version 2", paths: ["docs"] }).then((hits) => {
      readSettled = true
      return hits
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(readSettled).toBe(false)

    releaseSecondFile()
    await refresh
    await expect(read).resolves.toEqual([
      expect.objectContaining({ path: "docs/a.md" }),
      expect.objectContaining({ path: "docs/b.md" }),
    ])
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
