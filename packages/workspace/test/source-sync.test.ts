import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { custom, defineWorkspace, markdown, useWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/core/registry.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { registerWorkspace } from "../src/test.ts"

import type { WorkspaceStore } from "../src/index.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-source-sync-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  resetWorkspaceRegistry()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("Workspace Source Sync", () => {
  it("requires explicit source selection and materializes sync-only sources on demand", async () => {
    registerWorkspace("explicit-sync", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: {
          sync: true,
          async getKeys() {
            return ["README.md", "guide/setup.md"]
          },
          async getItem(key: string) {
            return { key, content: `# ${key}\n` }
          },
        },
      },
    }))

    const workspace = await useRegisteredWorkspace("explicit-sync")

    await expect(workspace.exists("docs/README.md")).resolves.toBe(false)
    await expect(workspace.sync(undefined as never)).rejects.toThrow("requires an explicit Source selection")

    const result = await workspace.sync({ sources: ["docs"] })

    expect(result).toMatchObject({
      published: false,
      status: "ready",
      sources: [{
        counts: {
          added: 2,
          removed: 0,
          unchanged: 0,
          updated: 0,
        },
        mountPath: "docs",
        source: "docs",
        status: "ready",
      }],
    })
    expect(result.sources[0]?.paths).toBeUndefined()
    await expect(workspace.readFile("docs/README.md")).resolves.toBe("# README.md\n")
    await expect(workspace.readFile("docs/guide/setup.md")).resolves.toBe("# guide/setup.md\n")
  })

  it("preserves streamed source content", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 254, 255])
    registerWorkspace("stream-sync", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        assets: {
          sync: true,
          async getKeys() {
            return ["blob.bin"]
          },
          async getItem(key: string) {
            return {
              key,
              contentStream: new ReadableStream({
                start(controller) {
                  controller.enqueue(bytes.slice(0, 3))
                  controller.enqueue(bytes.slice(3))
                  controller.close()
                },
              }),
              mediaType: "application/octet-stream",
            }
          },
        },
      },
    }))

    const workspace = await useRegisteredWorkspace("stream-sync")
    const result = await workspace.sync({ sources: ["assets"] })

    expect(result.sources[0]?.counts.added).toBe(1)
    await expect(workspace.readFile("assets/blob.bin", { encoding: "binary" })).resolves.toEqual(bytes)
  })

  it("returns path details when requested and removes stale files only when configured", async () => {
    const items = new Map([
      ["README.md", "# Readme v1\n"],
      ["guide.md", "# Guide\n"],
      ["stale/old.md", "# Stale\n"],
    ])
    registerWorkspace("stale-sync", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: custom({
          sync: { stale: "remove" },
          async getKeys() {
            return [...items.keys()]
          },
          async getItem(key: string) {
            return { key, content: items.get(key) || "" }
          },
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("stale-sync")
    await workspace.sync({ sources: ["docs"] })

    items.set("README.md", "# Readme v2\n")
    items.delete("stale/old.md")
    items.set("new.md", "# New\n")

    const result = await workspace.sync({ details: "paths", sources: ["docs"] })

    expect(result.sources[0]).toMatchObject({
      counts: {
        added: 1,
        removed: 1,
        unchanged: 1,
        updated: 1,
      },
      status: "ready",
    })
    expect(result.sources[0]?.paths).toEqual(expect.arrayContaining([
      { path: "docs/README.md", sourcePath: "README.md", status: "updated" },
      { path: "docs/guide.md", sourcePath: "guide.md", status: "unchanged" },
      { path: "docs/new.md", sourcePath: "new.md", status: "added" },
      { path: "docs/stale/old.md", sourcePath: "stale/old.md", status: "removed" },
    ]))
    await expect(workspace.exists("docs/stale/old.md")).resolves.toBe(false)
    await expect(workspace.exists("docs/stale")).resolves.toBe(false)
    await expect(workspace.readFile("docs/README.md")).resolves.toBe("# Readme v2\n")
  })

  it("removes stale files from durable stores using sync state digests", async () => {
    const store = workspaceStoreWithoutFileMetadata(createMemoryWorkspaceStore())
    const items = new Map([
      ["README.md", "# Readme\n"],
      ["stale.md", "# Stale\n"],
    ])
    registerWorkspace("durable-stale-sync", defineWorkspace({
      store,
      sources: {
        docs: {
          sync: { stale: "remove" },
          async getKeys() {
            return [...items.keys()]
          },
          async getItem(key: string) {
            return { key, content: items.get(key) || "" }
          },
        },
      },
    }))

    const workspace = await useRegisteredWorkspace("durable-stale-sync")
    await workspace.sync({ sources: ["docs"] })

    items.delete("stale.md")
    const result = await workspace.sync({ sources: ["docs"] })

    expect(result.sources[0]?.counts.removed).toBe(1)
    await expect(workspace.exists("docs/stale.md")).resolves.toBe(false)
  })

  it("prunes empty source directories from local stores", async () => {
    const root = await createRoot()
    const items = new Map([
      ["stale/old.md", "# Stale\n"],
    ])
    registerWorkspace("local-stale-sync", defineWorkspace({
      store: createLocalWorkspaceStore(root),
      sources: {
        docs: {
          sync: { stale: "remove" },
          async getKeys() {
            return [...items.keys()]
          },
          async getItem(key: string) {
            return { key, content: items.get(key) || "" }
          },
        },
      },
    }))

    const workspace = await useRegisteredWorkspace("local-stale-sync")
    await workspace.sync({ sources: ["docs"] })

    items.clear()
    const result = await workspace.sync({ sources: ["docs"] })

    expect(result.sources[0]?.counts.removed).toBe(1)
    await expect(workspace.exists("docs/stale")).resolves.toBe(false)
  })

  it("does not rewrite sync state for unchanged no-op source syncs", async () => {
    const base = createMemoryWorkspaceStore()
    let setMetaCalls = 0
    const store = workspaceStoreWithOverrides(base, {
      async setMeta(key, value) {
        setMetaCalls++
        await base.setMeta?.(key, value)
      },
    })
    registerWorkspace("noop-state-sync", defineWorkspace({
      store,
      sources: {
        docs: {
          sync: true,
          async getKeys() {
            return ["README.md"]
          },
          async getItem(key: string) {
            return { key, content: "# Readme\n" }
          },
        },
      },
    }))

    const workspace = await useRegisteredWorkspace("noop-state-sync")
    await workspace.sync({ sources: ["docs"] })
    await workspace.sync({ sources: ["docs"] })

    expect(setMetaCalls).toBe(1)
  })

  it("rejects unsafe source sync item paths before writing files", async () => {
    registerWorkspace("unsafe-path-sync", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: {
          sync: true,
          async getKeys() {
            return ["../outside.md"]
          },
          async getItem(key: string) {
            return { key, content: "# Unsafe\n" }
          },
        },
      },
    }))

    const workspace = await useRegisteredWorkspace("unsafe-path-sync")
    const result = await workspace.sync({ sources: ["docs"] })

    expect(result.status).toBe("error")
    expect(result.sources[0]?.error).toContain("Workspace path")
    await expect(workspace.exists("outside.md")).resolves.toBe(false)
  })

  it("syncs all sync-eligible sources without touching build-only sources", async () => {
    registerWorkspace("all-sync", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        synced: {
          sync: true,
          async getKeys() {
            return ["ready.md"]
          },
          async getItem(key: string) {
            return { key, content: "# Ready\n" }
          },
        },
        buildOnly: {
          async getKeys() {
            return ["build.md"]
          },
          async getItem(key: string) {
            return { key, content: "# Build\n" }
          },
        },
      },
    }))

    const workspace = await useRegisteredWorkspace("all-sync")
    const result = await workspace.sync({ sources: "all" })

    expect(result.sources.map(item => item.source)).toEqual(["synced"])
    await expect(workspace.readFile("synced/ready.md")).resolves.toBe("# Ready\n")
    await expect(workspace.diff()).resolves.toMatchObject({
      entries: [
        expect.objectContaining({ path: "synced", type: "added" }),
        expect.objectContaining({ path: "synced/ready.md", type: "added" }),
      ],
    })
  })

  it("can snapshot and publish after successful source sync", async () => {
    const publish = vi.fn()
    registerWorkspace("publish-sync", defineWorkspace({
      publish: [{
        name: "test-publisher",
        publish,
      }],
      store: { provider: "memory" },
      sources: {
        docs: {
          sync: true,
          async getKeys() {
            return ["README.md"]
          },
          async getItem(key: string) {
            return { key, content: "# Published\n" }
          },
        },
      },
    }))

    const workspace = await useRegisteredWorkspace("publish-sync")
    const result = await workspace.sync({
      publish: true,
      snapshot: { message: "sync docs" },
      sources: ["docs"],
    })

    expect(result.published).toBe(true)
    expect(result.snapshot).toMatchObject({ name: "sync docs" })
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({ name: "sync docs" }),
    }))
  })

  it("can apply successful source plans and publish partial sync results when requested", async () => {
    const publish = vi.fn()
    registerWorkspace("partial-sync", defineWorkspace({
      publish: [{
        name: "test-publisher",
        publish,
      }],
      store: { provider: "memory" },
      sources: {
        docs: {
          sync: true,
          async getKeys() {
            return ["README.md"]
          },
          async getItem(key: string) {
            return { key, content: "# Ready\n" }
          },
        },
        broken: {
          sync: true,
          async getKeys() {
            throw new Error("upstream unavailable")
          },
          async getItem(key: string) {
            return { key, content: "" }
          },
        },
      },
    }))

    const workspace = await useRegisteredWorkspace("partial-sync")
    const result = await workspace.sync({
      publish: true,
      publishPartial: true,
      snapshot: { message: "partial sync" },
      sources: "all",
    })

    expect(result.status).toBe("partial")
    expect(result.published).toBe(true)
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "docs", status: "ready" }),
      expect.objectContaining({ source: "broken", status: "error" }),
    ]))
    await expect(workspace.readFile("docs/README.md")).resolves.toBe("# Ready\n")
    expect(publish).toHaveBeenCalled()
  })

  it("infers plain object source helpers and defaults sync bindings to no build or lazy materialization", async () => {
    const root = await createRoot()
    await mkdir(join(root, "content"), { recursive: true })
    await writeFile(join(root, "content", "README.md"), "# Plain object\n")

    registerWorkspace("plain-object-sync", defineWorkspace({
      rootDir: root,
      store: { provider: "memory" },
      sources: {
        docs: {
          cwd: "content",
          include: "*.md",
          sync: true,
        },
      },
    }))

    const workspace = await useRegisteredWorkspace("plain-object-sync")

    await expect(workspace.exists("docs/README.md")).resolves.toBe(false)
    await workspace.sync({ sources: ["docs"] })
    await expect(workspace.readFile("docs/README.md")).resolves.toBe("# Plain object\n")
  })

  it("supports Source Sync from the public writable workspace facade", async () => {
    registerWorkspace("public-sync", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: {
          sync: true,
          async getKeys() {
            return ["README.md"]
          },
          async getItem(key: string) {
            return { key, content: "# Public\n" }
          },
        },
      },
    }))

    const workspace = useWorkspace("public-sync", { mode: "write" })
    const result = await workspace.sync({ sources: ["docs"], snapshot: { message: "sync docs" } })

    expect(result.status).toBe("ready")
    await expect(workspace.fs.readFile("docs/README.md")).resolves.toBe("# Public\n")
    await expect(workspace.fs.writeFile("docs/README.md", "# Edited\n")).rejects.toThrow("read-only")
  })

  it("preserves sync options on markdown helper sources", async () => {
    const root = await createRoot()
    await writeFile(join(root, "README.md"), "# Markdown\n")

    registerWorkspace("markdown-helper-sync", defineWorkspace({
      rootDir: root,
      store: { provider: "memory" },
      sources: {
        docs: markdown({
          path: "README.md",
          sync: true,
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("markdown-helper-sync")
    await workspace.sync({ sources: ["docs"] })

    await expect(workspace.readFile("docs/README.md")).resolves.toBe("# Markdown\n")
  })

  it("rejects ambiguous plain object source configuration", async () => {
    registerWorkspace("ambiguous-sync", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: {
          repo: "acme/docs",
          sync: true,
          url: "https://example.com/docs.json",
        },
      },
    }))

    await expect(useRegisteredWorkspace("ambiguous-sync")).rejects.toThrow("ambiguous")

    registerWorkspace("ambiguous-local-sync", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: {
          include: "*.md",
          path: "README.md",
          sync: true,
        },
      },
    }))

    await expect(useRegisteredWorkspace("ambiguous-local-sync")).rejects.toThrow("ambiguous")
  })
})

function workspaceStoreWithoutFileMetadata(store: WorkspaceStore): WorkspaceStore {
  return workspaceStoreWithOverrides(store, {
    async readFile(path) {
      const file = await store.readFile(path)
      return file ? { ...file, metadata: undefined } : undefined
    },
  })
}

function workspaceStoreWithOverrides(store: WorkspaceStore, overrides: Partial<WorkspaceStore>): WorkspaceStore {
  return {
    readFile: overrides.readFile ?? (async path => await store.readFile(path)),
    writeFile: overrides.writeFile ?? (async (path, file) => await store.writeFile(path, file)),
    list: overrides.list ?? (async (prefix, options) => await store.list(prefix, options)),
    glob: overrides.glob ?? (async (pattern, options) => await store.glob(pattern, options)),
    stat: overrides.stat ?? (async path => await store.stat(path)),
    mkdir: overrides.mkdir ?? (async (path, options) => await store.mkdir(path, options)),
    rm: overrides.rm ?? (async (path, options) => await store.rm(path, options)),
    snapshot: overrides.snapshot ?? (async options => await store.snapshot(options)),
    diff: overrides.diff ?? (async options => await store.diff(options)),
    getMeta: overrides.getMeta ?? (async key => await store.getMeta?.(key)),
    setMeta: overrides.setMeta ?? (async (key, value) => await store.setMeta?.(key, value)),
  }
}
