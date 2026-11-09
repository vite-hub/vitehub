import { afterAll, beforeEach, expect, it, vi } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import { cancelWorkflow, createWorkflow, deferWorkflow, getWorkflowRun, resumeWorkflowSignal, runWorkflow } from "../src/runtime/client.ts"
import { setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"
import { setVercelWorkflowRuntimeLoader } from "../src/runtime/vercel.ts"

const mode = enableViteHubTestMode()
const handler = vi.fn()

beforeEach(async () => {
  await mode.reset()
  handler.mockClear()
  setWorkflowRuntimeConfig({ provider: "openworkflow" })
  setWorkflowRuntimeRegistry({ onboarding: async () => ({ handler }), digest: async () => ({ handler }) })
})

afterAll(async () => {
  await mode.reset()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
  setWorkflowRuntimeConfig(undefined)
  setWorkflowRuntimeRegistry(undefined)
  setVercelWorkflowRuntimeLoader()
})

it("records valid starts without a provider or handler, and reset empties the list", async () => {
  const run = await runWorkflow("onboarding", { userId: 1 }, { id: "run-1" })
  expect(run).toEqual({ id: "run-1", payload: { userId: 1 }, provider: "openworkflow", status: "queued" })
  expect(await runWorkflow("onboarding", { userId: 2 }, { id: "run-1" })).toEqual(run)
  await deferWorkflow("digest", { day: 1 })
  await createWorkflow<{ day: number }>("digest").run({ day: 2 })

  expect(mode.peek("workflow")).toMatchObject([
    { deferred: false, id: "run-1", payload: { userId: 1 }, workflow: "onboarding" },
    { deferred: true, payload: { day: 1 }, workflow: "digest" },
    { deferred: false, payload: { day: 2 }, workflow: "digest" },
  ])
  expect(await cancelWorkflow("onboarding", "run-1")).toMatchObject({ id: "run-1", status: "cancelled" })
  expect(await getWorkflowRun("onboarding", "run-1")).toMatchObject({ status: "cancelled" })
  expect(await getWorkflowRun("onboarding", "missing")).toEqual({ id: "missing", provider: "openworkflow", status: "unknown" })
  expect(handler).not.toHaveBeenCalled()

  await mode.reset()
  expect(mode.peek("workflow")).toBeUndefined()
})

it("rejects starts, reads, cancellations, and signals when Workflow is disabled", async () => {
  setWorkflowRuntimeConfig(false)
  await expect(runWorkflow("onboarding", {})).rejects.toMatchObject({ code: "WORKFLOW_DISABLED" })
  await expect(getWorkflowRun("onboarding", "run-1")).rejects.toMatchObject({ code: "WORKFLOW_DISABLED" })
  await expect(cancelWorkflow("onboarding", "run-1")).rejects.toMatchObject({ code: "WORKFLOW_DISABLED" })
  await expect(resumeWorkflowSignal("token", {})).rejects.toMatchObject({ code: "WORKFLOW_DISABLED" })
  expect(mode.peek("workflow")).toBeUndefined()
})

it("rejects unknown Definitions before starts and cancellations", async () => {
  await expect(runWorkflow("missing", {})).rejects.toMatchObject({ code: "WORKFLOW_DEFINITION_NOT_FOUND" })
  await expect(deferWorkflow("missing", {})).rejects.toMatchObject({ code: "WORKFLOW_DEFINITION_NOT_FOUND" })
  await expect(cancelWorkflow("missing", "run-1")).rejects.toMatchObject({ code: "WORKFLOW_DEFINITION_NOT_FOUND" })
  expect(mode.peek("workflow")).toBeUndefined()
})

it.each(["cloudflare", "vercel"] as const)("preserves unsupported %s cancellation", async (provider) => {
  setWorkflowRuntimeConfig({ provider })
  const run = await runWorkflow("onboarding", {})
  await expect(cancelWorkflow("onboarding", run.id)).rejects.toMatchObject({ code: "WORKFLOW_OPERATION_UNSUPPORTED", details: { operation: "cancellation", provider } })
  expect(await getWorkflowRun("onboarding", run.id)).toMatchObject({ status: "queued" })
})

it("rejects caller run IDs for native Vercel Workflows but captures supported starts and cancellations", async () => {
  setWorkflowRuntimeConfig({ provider: "vercel" })
  setWorkflowRuntimeRegistry({ onboarding: async () => ({ handler, options: { native: handler } }) })
  await expect(runWorkflow("onboarding", {}, { id: "custom" })).rejects.toMatchObject({ code: "WORKFLOW_RUN_ID_UNSUPPORTED" })
  expect(mode.peek("workflow")).toBeUndefined()
  const run = await runWorkflow("onboarding", {})
  expect(await cancelWorkflow("onboarding", run.id)).toMatchObject({ status: "cancelled" })
})

it.each(["cloudflare", "openworkflow", "vercel"] as const)("rejects %s signals without loading a provider", async (provider) => {
  setWorkflowRuntimeConfig({ provider })
  const loadProvider = vi.fn(async () => { throw new Error("provider must not load") })
  setVercelWorkflowRuntimeLoader(loadProvider)
  await expect(resumeWorkflowSignal("valid-hook-token", {})).rejects.toMatchObject({ code: "WORKFLOW_OPERATION_UNSUPPORTED", details: { operation: "signals", provider } })
  expect(loadProvider).not.toHaveBeenCalled()
})
