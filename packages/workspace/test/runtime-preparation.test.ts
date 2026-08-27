import { describe, expect, it, vi } from "vitest"

import { custom } from "../src/index.ts"
import {
  createWorkspacePreparation,
  registerWorkspace,
  useWorkspace,
} from "../src/runtime.ts"

import type { SourceContext, WorkspaceSourceItem } from "../src/index.ts"

function registerPreparationWorkspace(getItems: (ctx: SourceContext) => Promise<WorkspaceSourceItem[]>) {
  const name = `workspace-preparation-${crypto.randomUUID()}`
  registerWorkspace(name, {
    sources: {
      docs: custom({
        cache: false,
        getItem: async key => ({ content: "# Ready", key }),
        getItems,
        getKeys: async () => ["ready.md"],
        materialize: "startup",
      }),
    },
    store: { provider: "memory" },
  })
  return name
}

describe("Workspace runtime preparation", () => {
  it("keeps startup Sources available as lazy read fallbacks", async () => {
    const name = registerPreparationWorkspace(async () => [{ content: "# Ready", key: "ready.md" }])
    const workspace = useWorkspace(name)

    await expect(workspace.fs.readFile("docs/ready.md", { encoding: "utf8" })).resolves.toBe("# Ready")
  })

  it("deduplicates concurrent starts and publishes non-cacheable readiness", async () => {
    const getItems = vi.fn(async () => [{ content: "# Ready", key: "ready.md" }])
    const states = vi.fn()
    const preparation = createWorkspacePreparation({
      onStateChange: states,
      workspace: registerPreparationWorkspace(getItems),
    })

    await expect(Promise.all([preparation.start(), preparation.start()])).resolves.toEqual([
      expect.objectContaining({ status: "ready" }),
      expect.objectContaining({ status: "ready" }),
    ])
    expect(getItems).toHaveBeenCalledOnce()
    expect(states).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ready" }))
    const response = preparation.response()
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    await expect(response.json()).resolves.toEqual({ ready: true, status: "ready" })
    await preparation.stop()
  })

  it("retries validation failures while keeping public errors minimal", async () => {
    let validationAttempts = 0
    const preparation = createWorkspacePreparation({
      retryDelayMs: 1,
      validate() {
        validationAttempts++
        if (validationAttempts === 1) throw new Error("consumer policy rejected the snapshot")
      },
      workspace: registerPreparationWorkspace(async () => [{ content: "# Ready", key: "ready.md" }]),
    })

    await expect(preparation.start()).resolves.toMatchObject({
      error: "consumer policy rejected the snapshot",
      status: "error",
    })
    const response = preparation.response()
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ ready: false, status: "error" })
    await vi.waitFor(() => expect(preparation.getState().status).toBe("ready"))
    expect(validationAttempts).toBe(2)
    await preparation.stop()
  })

  it("reports Source failures internally and stops scheduled retries", async () => {
    const getItems = vi.fn(async () => {
      throw new Error("private provider failure")
    })
    const preparation = createWorkspacePreparation({
      retryDelayMs: 60_000,
      workspace: registerPreparationWorkspace(getItems),
    })

    await expect(preparation.start()).resolves.toMatchObject({
      error: expect.stringContaining("sources failed to prepare: docs"),
      status: "error",
    })
    await expect(preparation.response().json()).resolves.toEqual({ ready: false, status: "error" })
    await preparation.stop()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(getItems).toHaveBeenCalledOnce()
  })

  it("aborts active preparation on stop and can start again", async () => {
    let started!: () => void
    const firstAttemptStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let attempts = 0
    const preparation = createWorkspacePreparation({
      workspace: registerPreparationWorkspace(async (ctx) => {
        attempts++
        if (attempts > 1) return [{ content: "# Ready", key: "ready.md" }]
        started()
        await new Promise<void>((_resolve, reject) => {
          const signal = ctx.abortSignal
          if (!signal) return reject(new Error("missing preparation abort signal"))
          const abort = () => reject(signal.reason)
          if (signal.aborted) abort()
          else signal.addEventListener("abort", abort, { once: true })
        })
        return []
      }),
    })

    const first = preparation.start()
    await firstAttemptStarted
    await preparation.stop()
    await expect(first).resolves.toMatchObject({ status: "preparing" })
    await expect(preparation.start()).resolves.toMatchObject({ status: "ready" })
    expect(attempts).toBe(2)
    await preparation.stop()
  })

  it("validates preparation options at creation", () => {
    expect(() => createWorkspacePreparation({ workspace: "" })).toThrow("requires a Workspace name")
    expect(() => createWorkspacePreparation({ retryDelayMs: -1, workspace: "docs" })).toThrow("retryDelayMs")
    expect(() => createWorkspacePreparation({ sources: [""], workspace: "docs" })).toThrow("sources")
  })
})
