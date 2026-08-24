import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { createWorkspace } from "../src/core/workspace.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"

import type { PublishContext, WorkspaceSnapshot } from "../src/core/types.ts"

describe("workspace publication", () => {
  it("publishes current Store entries and digest without creating a snapshot", async () => {
    const store = createMemoryWorkspaceStore()
    const snapshot = vi.spyOn(store, "snapshot")
    const diff = vi.spyOn(store, "diff")
    const publish = vi.fn<(context: PublishContext) => Promise<void>>(async () => {})
    const workspace = createWorkspace({
      name: "current-state",
      publish: [{ name: "test", publish }],
      store,
    })

    await workspace.writeFile("notes/todo.md", "ship it", { mediaType: "text/markdown" })
    await workspace.publish({ name: "publish current state" })

    expect(snapshot).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledOnce()
    expect(publish.mock.calls[0]?.[0].snapshot).toMatchObject({
      entries: {
        "notes/todo.md": {
          digest: expect.any(String),
          size: 7,
          type: "file",
        },
      },
      id: expect.any(String),
      name: "publish current state",
    })
    expect(diff).not.toHaveBeenCalled()
  })

  it("keeps durable snapshot semantics unchanged", async () => {
    const store = createMemoryWorkspaceStore()
    const durableSnapshot: WorkspaceSnapshot = {
      createdAt: new Date(0).toISOString(),
      entries: {},
      id: "durable-snapshot",
      name: "durable state",
    }
    const snapshot = vi.spyOn(store, "snapshot").mockResolvedValue(durableSnapshot)
    const publish = vi.fn<(context: PublishContext) => Promise<void>>(async () => {})
    const workspace = createWorkspace({
      name: "durable-state",
      publish: [{ name: "test", publish }],
      store,
    })

    const result = await workspace.snapshot({ name: "durable state" })

    expect(snapshot).toHaveBeenCalledWith({ name: "durable state" })
    expect(result).toBe(durableSnapshot)
    expect(publish.mock.calls[0]?.[0].snapshot).toBe(durableSnapshot)
  })

  it("publishes digest-bearing current entries from a Local Store", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-publish-"))
    try {
      const store = createLocalWorkspaceStore(root)
      const publish = vi.fn<(context: PublishContext) => Promise<void>>(async () => {})
      const workspace = createWorkspace({
        name: "local-current-state",
        publish: [{ name: "test", publish }],
        store,
      })

      await workspace.writeFile("notes/todo.md", "ship it")
      await workspace.publish()

      expect(publish.mock.calls[0]?.[0]?.snapshot?.entries["notes/todo.md"]).toMatchObject({
        digest: expect.any(String),
        size: 7,
        type: "file",
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("bounds Local Store digest work during publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-publish-concurrency-"))
    try {
      const store = createLocalWorkspaceStore(root)
      const stat = store.stat.bind(store)
      let active = 0
      let maxActive = 0
      store.stat = async (...args) => {
        active++
        maxActive = Math.max(maxActive, active)
        try {
          await new Promise(resolve => setTimeout(resolve, 1))
          return await stat(...args)
        }
        finally {
          active--
        }
      }
      const workspace = createWorkspace({
        name: "bounded-local-current-state",
        publish: [{ name: "test", publish: async () => {} }],
        store,
      })
      await Promise.all(Array.from({ length: 40 }, (_, index) => workspace.writeFile(`${index}.txt`, String(index))))

      await workspace.publish()

      expect(maxActive).toBeGreaterThan(1)
      expect(maxActive).toBeLessThanOrEqual(16)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("does no Store work when no publishers are configured", async () => {
    const store = createMemoryWorkspaceStore()
    const diff = vi.spyOn(store, "diff")
    const list = vi.spyOn(store, "list")
    const snapshot = vi.spyOn(store, "snapshot")
    const workspace = createWorkspace({ name: "no-publishers", store })

    await workspace.publish()

    expect(diff).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
  })
})
