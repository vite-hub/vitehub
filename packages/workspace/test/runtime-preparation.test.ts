import { describe, expect, it, vi } from "vitest"

import { custom } from "../src/index.ts"
import {
  createWorkspacePreparation,
  registerWorkspace,
  useWorkspace,
} from "../src/runtime.ts"
import { resetWorkspaceRegistry, resolveRegisteredWorkspaceDefinition, setWorkspaceRegistry } from "../src/core/registry.ts"

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
  it("is stopped until preparation starts", async () => {
    const preparation = createWorkspacePreparation({
      workspace: registerPreparationWorkspace(async () => [{ content: "# Ready", key: "ready.md" }]),
    })

    expect(preparation.getState()).toMatchObject({ status: "stopped" })
    expect(preparation.response().status).toBe(503)
    await expect(preparation.response().json()).resolves.toEqual({ ready: false, status: "stopped" })
  })

  it("stops without waiting for a pending registry loader", async () => {
    const name = `workspace-preparation-${crypto.randomUUID()}`
    let loading!: () => void
    const loaderStarted = new Promise<void>((resolve) => {
      loading = resolve
    })
    setWorkspaceRegistry({
      [name]: async () => {
        loading()
        await new Promise(() => {})
        return {}
      },
    })
    const preparation = createWorkspacePreparation({ workspace: name })

    const started = preparation.start()
    await loaderStarted
    await expect(preparation.stop()).resolves.toBeUndefined()
    await expect(started).resolves.toMatchObject({ status: "stopped" })
    resetWorkspaceRegistry()
  })

  it("stops an attempt from the preparing state callback", async () => {
    const getItems = vi.fn(async () => [{ content: "# Ready", key: "ready.md" }])
    let stopping: Promise<void> | undefined
    let preparation!: ReturnType<typeof createWorkspacePreparation>
    preparation = createWorkspacePreparation({
      onStateChange(state) {
        if (state.status === "preparing") stopping = preparation.stop()
      },
      workspace: registerPreparationWorkspace(getItems),
    })

    await expect(preparation.start()).resolves.toMatchObject({ status: "stopped" })
    await stopping
    expect(getItems).not.toHaveBeenCalled()
  })

  it("does not let an abandoned registry load replace a restarted definition", async () => {
    const name = `workspace-preparation-${crypto.randomUUID()}`
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstStarted!: () => void
    const firstLoading = new Promise<void>((resolve) => { firstStarted = resolve })
    let firstFinished!: () => void
    const firstLoaded = new Promise<void>((resolve) => { firstFinished = resolve })
    let attempts = 0
    const definition = (rootDir: string) => ({
      rootDir,
      sources: {
        docs: custom({
          materialize: "startup" as const,
          async getItems() { return [{ content: "# Ready", key: "ready.md" }] },
          async getItem(key: string) { return { content: "# Ready", key } },
          async getKeys() { return ["ready.md"] },
        }),
      },
      store: { provider: "memory" as const },
    })
    setWorkspaceRegistry({
      [name]: async () => {
        attempts++
        if (attempts === 1) {
          firstStarted()
          await firstBlocked
          firstFinished()
          return { default: definition("first") }
        }
        return { default: definition("second") }
      },
    })
    const preparation = createWorkspacePreparation({ workspace: name })

    const first = preparation.start()
    await firstLoading
    await preparation.stop()
    const restarted = preparation.start()
    await expect(restarted).resolves.toMatchObject({ status: "ready" })
    releaseFirst()
    await firstLoaded
    await expect(first).resolves.toMatchObject({ status: "stopped" })
    await expect(resolveRegisteredWorkspaceDefinition(name)).resolves.toMatchObject({ rootDir: "second" })
    await preparation.stop()
    resetWorkspaceRegistry()
  })

  it("shares a concurrent registry definition load", async () => {
    const name = `workspace-preparation-${crypto.randomUUID()}`
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const load = vi.fn(async () => {
      await blocked
      return { default: { rootDir: "shared" } }
    })
    setWorkspaceRegistry({ [name]: load })

    const first = resolveRegisteredWorkspaceDefinition(name)
    const second = resolveRegisteredWorkspaceDefinition(name)
    release()

    const [firstDefinition, secondDefinition] = await Promise.all([first, second])
    expect(load).toHaveBeenCalledOnce()
    expect(secondDefinition).toBe(firstDefinition)
    resetWorkspaceRegistry()
  })

  it("restarts with fresh definition synchronization after cancellation", async () => {
    const name = `workspace-preparation-${crypto.randomUUID()}`
    let attempts = 0
    let loading!: () => void
    const loaderStarted = new Promise<void>((resolve) => { loading = resolve })
    registerWorkspace(name, {
      loaders: [{
        name: "blocking-loader",
        async load(ctx) {
          attempts++
          if (attempts === 1) {
            loading()
            await new Promise<void>((_resolve, reject) => {
              const abort = () => reject(ctx.abortSignal?.reason)
              if (ctx.abortSignal?.aborted) abort()
              else ctx.abortSignal?.addEventListener("abort", abort, { once: true })
            })
          }
        },
      }],
      sources: {
        docs: custom({
          materialize: "startup",
          async getItems() { return [{ content: "# Ready", key: "ready.md" }] },
          async getItem(key) { return { content: "# Ready", key } },
          async getKeys() { return ["ready.md"] },
        }),
      },
      store: { provider: "memory" },
    })
    const preparation = createWorkspacePreparation({ workspace: name })

    const first = preparation.start()
    await loaderStarted
    await preparation.stop()
    await expect(first).resolves.toMatchObject({ status: "stopped" })
    await expect(preparation.start()).resolves.toMatchObject({ status: "ready" })
    expect(attempts).toBe(2)
    await preparation.stop()
  })

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
    expect(preparation.getState()).toMatchObject({ status: "stopped" })
    expect(preparation.response().status).toBe(503)
    await expect(preparation.response().json()).resolves.toEqual({ ready: false, status: "stopped" })
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

  it("serializes a restart with active preparation shutdown", async () => {
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
    const stopping = preparation.stop()
    const restarted = preparation.start()
    const concurrentRestart = preparation.start()
    await expect(first).resolves.toMatchObject({ status: "stopped" })
    await stopping
    await expect(restarted).resolves.toMatchObject({ status: "ready" })
    await expect(concurrentRestart).resolves.toMatchObject({ status: "ready" })
    expect(attempts).toBe(2)
    await preparation.stop()
  })

  it("stops without waiting for a pending validator", async () => {
    let validating!: () => void
    const validationStarted = new Promise<void>((resolve) => {
      validating = resolve
    })
    const preparation = createWorkspacePreparation({
      validate: async () => {
        validating()
        await new Promise(() => {})
      },
      workspace: registerPreparationWorkspace(async () => [{ content: "# Ready", key: "ready.md" }]),
    })

    const started = preparation.start()
    await validationStarted
    await expect(preparation.stop()).resolves.toBeUndefined()
    await expect(started).resolves.toMatchObject({ status: "stopped" })
  })

  it("shares startup materialization with a concurrent lazy read", async () => {
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
      return [{ content: "# Ready", key: "ready.md" }]
    })
    const name = registerPreparationWorkspace(getItems)
    const preparation = createWorkspacePreparation({ workspace: name })

    const preparing = preparation.start()
    await materializing
    const reading = useWorkspace(name).fs.readFile("docs/ready.md", { encoding: "utf8" })
    release()

    await expect(preparing).resolves.toMatchObject({ status: "ready" })
    await expect(reading).resolves.toBe("# Ready")
    expect(getItems).toHaveBeenCalledOnce()
    await preparation.stop()
  })

  it("shares completed startup materialization with later Workspace views", async () => {
    const getItems = vi.fn(async () => [{ content: "# Ready", key: "ready.md" }])
    const name = registerPreparationWorkspace(getItems)
    const preparation = createWorkspacePreparation({ workspace: name })

    await expect(preparation.start()).resolves.toMatchObject({ status: "ready" })
    await expect(useWorkspace(name).fs.glob("docs/**/*.md")).resolves.toEqual([
      expect.objectContaining({ path: "docs/ready.md", type: "file" }),
    ])
    expect(getItems).toHaveBeenCalledOnce()
    await preparation.stop()
  })

  it("validates preparation options at creation", () => {
    expect(() => createWorkspacePreparation({ workspace: "" })).toThrow("requires a Workspace name")
    expect(() => createWorkspacePreparation({ retryDelayMs: -1, workspace: "docs" })).toThrow("retryDelayMs")
    expect(() => createWorkspacePreparation({ retryDelayMs: 2_147_483_648, workspace: "docs" })).toThrow("retryDelayMs")
    expect(() => createWorkspacePreparation({ sources: [""], workspace: "docs" })).toThrow("sources")
  })
})
