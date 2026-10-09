import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { afterEach, assert, describe, expect, it, vi } from "vitest"

import { createWorkflow } from "../src/runtime/client.ts"
import { getWorkflowRunState, resetWorkflowRuntime, setWorkflowRun, setWorkflowRuntimeConfig } from "../src/runtime/state.ts"

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => { resolve = accept })
  return { promise, resolve }
}

afterEach(() => {
  resetWorkflowRuntime()
  vi.useRealTimers()
})

describe("inline Workflow run retention", () => {
  it("keeps completed runs distinct when workflow names and IDs contain delimiters", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    const first = createWorkflow("tenant", () => "first result")
    const second = createWorkflow("tenant\0admin", () => "second result")

    await first.run(undefined, { id: "admin\0run" })
    await getWorkflowRunState(first.name, "admin\0run")!.promise
    await second.run(undefined, { id: "run" })
    await getWorkflowRunState(second.name, "run")!.promise

    const firstRun = await first.getRun("admin\0run")
    const secondRun = await second.getRun("run")
    expect(firstRun.status).toBe("completed")
    expect(secondRun.status).toBe("completed")
    assert(firstRun.result instanceof Response)
    assert(secondRun.result instanceof Response)
    await expect(firstRun.result.clone().text()).resolves.toBe("first result")
    await expect(secondRun.result.clone().text()).resolves.toBe("second result")
  })

  it("keeps active runs distinct when workflow names and IDs contain delimiters", async () => {
    const first = gate()
    const firstState = setWorkflowRun("tenant", "admin\0run", first.promise.then(() => ({ result: "first", status: "completed" as const })))
    const secondState = setWorkflowRun("tenant\0admin", "run", Promise.resolve({ result: "second", status: "completed" }))

    try {
      expect(getWorkflowRunState("tenant", "admin\0run")).toBe(firstState)
      await secondState.promise
      expect(getWorkflowRunState("tenant", "admin\0run")?.status).toBe("running")
    }
    finally {
      first.resolve()
      await firstState.promise
    }

    expect(getWorkflowRunState("tenant", "admin\0run")?.result).toBe("first")
    expect(getWorkflowRunState("tenant\0admin", "run")?.result).toBe("second")
  })

  it.each(["WeakRef", "FinalizationRegistry", "both"] as const)("bounds active inspection without %s", async (missing) => {
    const globals = globalThis as unknown as {
      WeakRef: WeakRefConstructor | undefined
      FinalizationRegistry: FinalizationRegistryConstructor | undefined
    }
    const weakRef = globals.WeakRef
    const finalizationRegistry = globals.FinalizationRegistry
    if (missing !== "FinalizationRegistry") globals.WeakRef = undefined
    if (missing !== "WeakRef") globals.FinalizationRegistry = undefined
    try {
      const evicted = gate()
      const old = setWorkflowRun("fallback", "old", evicted.promise.then(() => ({ status: "completed" as const })))
      for (let index = 0; index < 1_024; index++) {
        setWorkflowRun("fallback", String(index), new Promise(() => {}))
      }
      expect(getWorkflowRunState("fallback", "old")).toBeUndefined()
      expect(getWorkflowRunState("fallback", "0")?.status).toBe("running")
      const active = gate()
      const state = setWorkflowRun("fallback", "active", active.promise.then(() => ({ result: "done", status: "completed" as const })))
      expect(getWorkflowRunState("fallback", "0")).toBeUndefined()
      expect(getWorkflowRunState("fallback", "1")?.status).toBe("running")
      expect(getWorkflowRunState("fallback", "active")).toBe(state)
      evicted.resolve()
      await old.promise
      expect(getWorkflowRunState("fallback", "old")).toBeUndefined()
      active.resolve()
      await expect(state.promise).resolves.toMatchObject({ status: "completed", result: "done" })
      expect(getWorkflowRunState("fallback", "active")?.result).toBe("done")
      // Completed history must not consume the fallback active-run budget.
      await setWorkflowRun("fallback", "done", Promise.resolve({ status: "completed" })).promise
      expect(getWorkflowRunState("fallback", "1")?.status).toBe("running")
    } finally {
      globals.WeakRef = weakRef
      globals.FinalizationRegistry = finalizationRegistry
    }
  })

  it("releases abandoned executions while retaining reachable active runs", async () => {
    const stateModule = new URL("../dist/runtime/state.js", import.meta.url).href
    await promisify(execFile)(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
      import assert from "node:assert/strict"
      import { setImmediate } from "node:timers/promises"
      const weakRef = globalThis.WeakRef
      const finalizationRegistry = globalThis.FinalizationRegistry
      globalThis.WeakRef = undefined
      globalThis.FinalizationRegistry = undefined
      const { getWorkflowRunState, resetWorkflowRuntime, setWorkflowRun } = await import(${JSON.stringify(stateModule)})
      resetWorkflowRuntime()
      assert.equal(getWorkflowRunState("gc", "missing"), undefined)
      globalThis.WeakRef = weakRef
      globalThis.FinalizationRegistry = finalizationRegistry

      let finish
      const execution = new Promise(resolve => { finish = resolve })
      setWorkflowRun("gc", "reachable", execution)
      for (let index = 0; index < 1_025; index++) {
        setWorkflowRun("gc", String(index), new Promise(() => {}))
      }
      let collected = false
      for (let attempt = 0; attempt < 100; attempt++) {
        await setImmediate()
        globalThis.gc()
        assert.equal(getWorkflowRunState("gc", "reachable")?.status, "running")
        if (Array.from({ length: 1_025 }, (_, index) => getWorkflowRunState("gc", String(index))).every(run => !run)) {
          collected = true
          break
        }
      }
      assert.ok(collected, "inspection must not retain an abandoned execution")
      finish({ status: "completed", result: "done" })
      await getWorkflowRunState("gc", "reachable").promise
      await setImmediate()
      globalThis.gc()
      assert.equal(getWorkflowRunState("gc", "reachable")?.result, "done")
    `])
  })

  it("keeps more than 1024 active runs inspectable through completion", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    const first = gate()
    const remaining = gate()
    const workflow = createWorkflow<boolean, string>("pending", async ({ payload }) => {
      await (payload ? first.promise : remaining.promise)
      return "done"
    })
    await workflow.run(true, { id: "first" })
    const firstState = getWorkflowRunState("pending", "first")!
    const started = await Promise.all(Array.from({ length: 1_024 }, (_, index) => workflow.run(false, { id: String(index) })))
    const pending = started.map(run => getWorkflowRunState("pending", run.id)!.promise)
    try {
      await expect(workflow.getRun("first")).resolves.toMatchObject({ status: "running" })
      first.resolve()
      await firstState.promise
      await expect(workflow.getRun("first")).resolves.toMatchObject({ result: expect.any(Response), status: "completed" })
    } finally {
      first.resolve()
      remaining.resolve()
      await Promise.all([firstState.promise, ...pending])
    }
  })

  it.each(["completed", "failed"] as const)("bounds %s history without evicting active runs", async (status) => {
    const active = gate()
    const state = setWorkflowRun("history", "active", active.promise.then(() => ({ status: "completed" as const })))
    for (let index = 0; index <= 1_024; index++) {
      await setWorkflowRun("history", String(index), Promise.resolve({ result: index, status })).promise
    }
    expect(getWorkflowRunState("history", "active")).toBe(state)
    expect(getWorkflowRunState("history", "0")).toBeUndefined()
    expect(getWorkflowRunState("history", "1")?.result).toBe(1)
    expect(getWorkflowRunState("history", "1024")?.result).toBe(1_024)
    active.resolve()
    await state.promise
    expect(getWorkflowRunState("history", "active")?.status).toBe("completed")
    expect(getWorkflowRunState("history", "1")).toBeUndefined()
  })

  it("expires completed runs after five minutes while retaining active runs", async () => {
    vi.useFakeTimers()
    const active = gate()
    const state = setWorkflowRun("history", "active", active.promise.then(() => ({ status: "completed" as const })))
    await setWorkflowRun("history", "done", Promise.resolve({ status: "completed" })).promise
    vi.setSystemTime(Date.now() + 5 * 60 * 1_000)
    expect(getWorkflowRunState("history", "done")).toBeUndefined()
    expect(getWorkflowRunState("history", "active")).toBe(state)
    active.resolve()
    await state.promise
  })

  it("keeps a replacement run when an older run with the same ID finishes", async () => {
    const old = gate()
    const oldState = setWorkflowRun("history", "shared", old.promise.then(() => ({ result: "old", status: "completed" as const })))
    const current = setWorkflowRun("history", "shared", Promise.resolve({ result: "new", status: "completed" }))
    await current.promise
    old.resolve()
    await oldState.promise
    expect(getWorkflowRunState("history", "shared")).toBe(current)
  })

  it("does not restore runs that complete after a runtime reset", async () => {
    const active = gate()
    const state = setWorkflowRun("history", "old", active.promise.then(() => ({ status: "completed" as const })))
    resetWorkflowRuntime()
    active.resolve()
    await state.promise
    expect(getWorkflowRunState("history", "old")).toBeUndefined()
  })
})
