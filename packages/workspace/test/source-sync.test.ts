import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { defineWorkspace, source } from "../src/index.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/core/registry.ts"
import { registerWorkspace } from "../src/test.ts"

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

  it("returns path details when requested and removes stale files only when configured", async () => {
    const items = new Map([
      ["README.md", "# Readme v1\n"],
      ["guide.md", "# Guide\n"],
      ["stale.md", "# Stale\n"],
    ])
    registerWorkspace("stale-sync", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: source.custom({
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
    items.delete("stale.md")
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
      { path: "docs/stale.md", sourcePath: "stale.md", status: "removed" },
    ]))
    await expect(workspace.exists("docs/stale.md")).resolves.toBe(false)
    await expect(workspace.readFile("docs/README.md")).resolves.toBe("# Readme v2\n")
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
  })
})
