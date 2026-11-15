import { afterEach, assert, describe, expect, it, vi } from "vitest"

import type { WorkflowProviderStep } from "../src/types.ts"
import { getCloudflareWorkflowBindingName } from "../src/integrations/cloudflare.ts"
import { createWorkflow, getWorkflowRun } from "../src/runtime/client.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"
import { enterWorkflowRuntimeEvent, getWorkflowRunState, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

afterEach(() => resetWorkflowRuntime())

async function runOnCloudflare(name: string, handler: () => unknown) {
  const step: WorkflowProviderStep = { do: async (_name, _options, run) => await run() }
  const registry = { [name]: async () => ({ default: { handler } }) }
  const output = await runCloudflareWorkflow({ config: { provider: "cloudflare" }, env: {}, event: { instanceId: "cf-1" }, name, registry, step })
  resetWorkflowRuntime()
  setWorkflowRuntimeConfig({ provider: "cloudflare" })
  setWorkflowRuntimeRegistry(registry)
  const binding = { createBatch: vi.fn(), get: async (id: string) => ({ id, status: async () => ({ status: "complete", output }) }) }
  enterWorkflowRuntimeEvent({ req: { runtime: { cloudflare: { env: { [getCloudflareWorkflowBindingName(name)]: binding } } } } })
  return await getWorkflowRun(name, "cf-1")
}

async function runInline(name: string, handler: () => unknown) {
  setWorkflowRuntimeConfig({ provider: "vercel" })
  const workflow = createWorkflow(name, handler)
  await workflow.start(undefined, { id: "inline-1" })
  await getWorkflowRunState(name, "inline-1")!.promise
  return await workflow.getRun("inline-1")
}

describe.each([
  ["inline", runInline],
  ["cloudflare", runOnCloudflare],
] as const)("Workflow run result on %s", (_provider, run) => {
  it("returns the value that the handler returned", async () => {
    const result = await run("plain", async () => ({ ok: true, userId: "u1" }))
    expect(result).toMatchObject({ result: { ok: true, userId: "u1" }, status: "completed" })
  })

  it("returns the JSON form of the value", async () => {
    const result = await run("json", async () => ({ at: new Date("2026-11-14T00:00:00.000Z"), missing: undefined, text: "hi" }))
    expect(result.result).toEqual({ at: "2026-11-14T00:00:00.000Z", text: "hi" })
  })

  it("keeps a string, null, and no value", async () => {
    expect((await run("text", () => "done")).result).toBe("done")
    resetWorkflowRuntime()
    expect((await run("null", () => null)).result).toBeNull()
    resetWorkflowRuntime()
    expect((await run("empty", () => undefined)).result).toBeUndefined()
  })

  it("keeps a Response when the handler returned one", async () => {
    const result = await run("response", () => Response.json({ ok: true }, { status: 201 }))
    assert(result.result instanceof Response)
    expect(result.result.status).toBe(201)
    await expect(result.result.json()).resolves.toEqual({ ok: true })
  })
})
