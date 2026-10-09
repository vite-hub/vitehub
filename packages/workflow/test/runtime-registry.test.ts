import { afterEach, describe, expect, it, vi } from "vitest"

import type { WorkflowDefinition } from "../src/types.ts"
import { createWorkflow, runWorkflow } from "../src/runtime/client.ts"
import { getInlineWorkflowDefinitions, loadWorkflowDefinition, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

afterEach(resetWorkflowRuntime)

function deferredDefinition() {
  let resolve!: (definition: WorkflowDefinition) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<WorkflowDefinition>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, reject, resolve }
}

describe("Workflow registry entries", () => {
  it.each(["constructor", "toString", "__proto__"])("allows an inline Workflow named %s with an empty registry", async (name) => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({})
    const workflow = createWorkflow(name, async () => "inline")

    const run = await workflow.run()
    expect(run).toMatchObject({ provider: "vercel", status: "queued" })
    await vi.waitFor(async () => {
      await expect(workflow.getRun(run.id)).resolves.toMatchObject({ result: expect.any(Response), status: "completed" })
    })
  })

  it.each(["constructor", "toString", "__proto__"])("reports a missing Workflow named %s", async (name) => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({})

    await expect(runWorkflow(name)).rejects.toMatchObject({ code: "WORKFLOW_DEFINITION_NOT_FOUND" })
  })

  it("does not load inherited definitions", async () => {
    setWorkflowRuntimeRegistry(Object.setPrototypeOf({}, {
      inherited: async () => ({ handler: async () => "inherited" }),
    }))

    await expect(loadWorkflowDefinition("inherited")).resolves.toBeUndefined()
  })

  it.each(["constructor", "toString", "__proto__"])("loads an own discovered definition named %s", async (name) => {
    const definition = { handler: async () => "discovered" }
    setWorkflowRuntimeRegistry({ [name]: async () => definition })

    await expect(loadWorkflowDefinition(name)).resolves.toBe(definition)
  })
})

describe("Workflow registry replacement", () => {
  it("preserves pending loads when installing the same registry", async () => {
    const pending = deferredDefinition()
    const loader = vi.fn(() => pending.promise)
    const registry = { report: loader }
    setWorkflowRuntimeRegistry(registry)
    const firstLoad = loadWorkflowDefinition("report")
    await Promise.resolve()

    setWorkflowRuntimeRegistry(registry)
    const secondLoad = loadWorkflowDefinition("report")
    pending.resolve({ handler: async () => "current" })

    await expect(firstLoad).resolves.toBe(await secondLoad)
    expect(loader).toHaveBeenCalledOnce()
  })

  it("invalidates settled definitions when installing the same registry", async () => {
    const first = { handler: async () => "first" }
    const second = { handler: async () => "second" }
    const loader = vi.fn(async () => first).mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const registry = { report: loader }
    setWorkflowRuntimeRegistry(registry)
    await expect(loadWorkflowDefinition("report")).resolves.toBe(first)

    setWorkflowRuntimeRegistry(registry)
    await expect(loadWorkflowDefinition("report")).resolves.toBe(second)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it("shares an inline handle from a pending module when installing the same registry", async () => {
    const pending = deferredDefinition()
    const handler = async () => "current"
    const importModule = vi.fn(async () => {
      await pending.promise
      return { report: createWorkflow("report", handler) }
    })
    let imported: ReturnType<typeof importModule> | undefined
    const loader = vi.fn(() => imported ??= importModule())
    const registry = { report: loader }
    setWorkflowRuntimeRegistry(registry)
    const firstLoad = loadWorkflowDefinition("report")
    await Promise.resolve()

    setWorkflowRuntimeRegistry(registry)
    const secondLoad = loadWorkflowDefinition("report")
    pending.resolve({ handler })

    const [first, second] = await Promise.all([firstLoad, secondLoad])
    expect(first?.handler).toBe(handler)
    expect(second).toBe(first)
    expect(loader).toHaveBeenCalledOnce()
    expect(importModule).toHaveBeenCalledOnce()
  })

  it("does not repopulate a reset cache when an old load finishes last", async () => {
    const pending = deferredDefinition()
    const current = { handler: async () => "new" }
    setWorkflowRuntimeRegistry({ report: () => pending.promise })
    const oldLoad = loadWorkflowDefinition("report")
    await Promise.resolve()
    resetWorkflowRuntime()
    setWorkflowRuntimeRegistry({ report: async () => current })
    await expect(loadWorkflowDefinition("report")).resolves.toBe(current)

    pending.resolve({ handler: async () => "old" })
    await oldLoad
    await expect(loadWorkflowDefinition("report")).resolves.toBe(current)
  })

  it.each(["replace", "reset"] as const)("does not reuse pending loads after %s", async (operation) => {
    const pending = deferredDefinition()
    const oldDefinition = { handler: async () => "old" }
    const newDefinition = { handler: async () => "new" }
    const oldLoader = vi.fn(() => pending.promise)
    const newLoader = vi.fn(async () => newDefinition)
    setWorkflowRuntimeRegistry({ report: oldLoader })
    const oldLoad = loadWorkflowDefinition("report")
    await Promise.resolve()
    expect(oldLoader).toHaveBeenCalledOnce()

    if (operation === "reset") resetWorkflowRuntime()
    setWorkflowRuntimeRegistry({ report: newLoader })
    const newLoad = loadWorkflowDefinition("report")
    pending.resolve(oldDefinition)

    await expect(oldLoad).resolves.toBe(oldDefinition)
    await expect(newLoad).resolves.toBe(newDefinition)
    await expect(loadWorkflowDefinition("report")).resolves.toBe(newDefinition)
    expect(newLoader).toHaveBeenCalledOnce()
  })

  it.each(["resolve", "reject"] as const)("keeps the replacement load when the stale load completes with %s", async (outcome) => {
    const stale = deferredDefinition()
    const replacement = deferredDefinition()
    const definition = { handler: async () => "new" }
    setWorkflowRuntimeRegistry({ report: () => stale.promise })
    const staleLoad = loadWorkflowDefinition("report").catch(() => undefined)
    await Promise.resolve()
    const loader = vi.fn(() => replacement.promise)
    setWorkflowRuntimeRegistry({ report: loader })
    const currentLoad = loadWorkflowDefinition("report")
    await Promise.resolve()

    if (outcome === "resolve") stale.resolve({ handler: async () => "old" })
    else stale.reject(new Error("Stale load failed"))
    await staleLoad
    const sharedLoad = loadWorkflowDefinition("report")
    await Promise.resolve()
    expect(loader).toHaveBeenCalledOnce()
    replacement.resolve(definition)
    await expect(currentLoad).resolves.toBe(definition)
    await expect(sharedLoad).resolves.toBe(definition)
    await expect(loadWorkflowDefinition("report")).resolves.toBe(definition)
    expect(loader).toHaveBeenCalledOnce()
  })

  it("clears inline definitions when a module loader rejects", async () => {
    const definition = { handler: async () => "inline" }
    const failure = new Error("load failed")
    setWorkflowRuntimeRegistry({
      report: () => {
        createWorkflow("report", definition.handler)
        return Promise.reject(failure)
      },
    })

    await expect(loadWorkflowDefinition("report")).rejects.toBe(failure)
    expect(getInlineWorkflowDefinitions().size).toBe(0)
  })
})
