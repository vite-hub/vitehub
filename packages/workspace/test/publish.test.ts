import { describe, expect, it, vi } from "vitest"

import { createWorkspace } from "../src/core/workspace.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

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
