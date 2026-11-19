import { afterAll, beforeEach, expect, it, vi } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import { cancelWorkflow, createWorkflow, deferWorkflow, getWorkflowRun, resumeWorkflow, startWorkflow } from "../src/runtime/client.ts"
import { runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"
import { setVercelWorkflowRuntimeLoader } from "../src/runtime/vercel.ts"
import { unwrap } from "./unwrap.ts"

const mode = enableViteHubTestMode()
const handler = vi.fn()

beforeEach(async () => {
  await mode.reset()
  handler.mockClear()
  setWorkflowRuntimeConfig({ driver: "openworkflow" })
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
  const run = await unwrap(startWorkflow("onboarding", { userId: 1 }, { id: "run-1" }))
  expect(run).toEqual({ id: "run-1", payload: { userId: 1 }, provider: "openworkflow", status: "queued" })
  expect(await unwrap(startWorkflow("onboarding", { userId: 2 }, { id: "run-1" }))).toEqual(run)
  const pending: Promise<unknown>[] = []
  const digest = createWorkflow<{ day: number }>("digest")
  await runWithWorkflowRuntimeEvent({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) }, () => {
    expect(deferWorkflow("digest", { day: 1 })).toBeUndefined()
    expect(digest.defer({ day: 3 })).toBeUndefined()
    expect(pending).toHaveLength(2)
  })
  await Promise.all(pending)
  await unwrap(digest.start({ day: 2 }))

  expect(mode.peek("workflow")).toMatchObject([
    { deferred: false, id: "run-1", payload: { userId: 1 }, workflow: "onboarding" },
    { deferred: true, payload: { day: 1 }, workflow: "digest" },
    { deferred: true, payload: { day: 3 }, workflow: "digest" },
    { deferred: false, payload: { day: 2 }, workflow: "digest" },
  ])
  expect(await unwrap(cancelWorkflow("onboarding", "run-1"))).toMatchObject({ id: "run-1", status: "cancelled" })
  expect(await unwrap(getWorkflowRun("onboarding", "run-1"))).toMatchObject({ status: "cancelled" })
  expect(await unwrap(getWorkflowRun("onboarding", "missing"))).toEqual({ id: "missing", provider: "openworkflow", status: "unknown" })
  expect(handler).not.toHaveBeenCalled()

  await mode.reset()
  expect(mode.peek("workflow")).toBeUndefined()
})

it("rejects starts, reads, cancellations, and signals when Workflow is disabled", async () => {
  setWorkflowRuntimeConfig(false)
  await expect(startWorkflow("onboarding", {})).rejects.toMatchObject({ code: "WORKFLOW_DISABLED" })
  await expect(getWorkflowRun("onboarding", "run-1")).rejects.toMatchObject({ code: "WORKFLOW_DISABLED" })
  await expect(cancelWorkflow("onboarding", "run-1")).rejects.toMatchObject({ code: "WORKFLOW_DISABLED" })
  await expect(resumeWorkflow("token", {})).rejects.toMatchObject({ code: "WORKFLOW_DISABLED" })
  expect(mode.peek("workflow")).toBeUndefined()
})

it("rejects unknown Definitions before starts and cancellations, and logs deferred failures", async () => {
  await expect(startWorkflow("missing", {})).rejects.toMatchObject({ code: "WORKFLOW_DEFINITION_NOT_FOUND" })
  await expect(cancelWorkflow("missing", "run-1")).rejects.toMatchObject({ code: "WORKFLOW_DEFINITION_NOT_FOUND" })
  const pending: Promise<unknown>[] = []
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    await runWithWorkflowRuntimeEvent({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) }, () => {
      expect(deferWorkflow("missing", {})).toBeUndefined()
      expect(createWorkflow("missing").defer()).toBeUndefined()
      expect(pending).toHaveLength(2)
    })
    await Promise.all(pending)
    expect(log).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith('[vitehub] Deferred Workflow start failed for "missing"', expect.objectContaining({ code: "WORKFLOW_DEFINITION_NOT_FOUND" }))
  }
  finally {
    log.mockRestore()
  }
  expect(mode.peek("workflow")).toBeUndefined()
})

it("preserves unsupported inline Vercel cancellation", async () => {
  setWorkflowRuntimeConfig({ driver: "vercel" })
  const run = await unwrap(startWorkflow("onboarding", {}))
  expect(await cancelWorkflow("onboarding", run.id)).toMatchObject([{ code: "WORKFLOW_OPERATION_UNSUPPORTED", data: { operation: "cancellation", provider: "vercel" } }, undefined])
  expect(await unwrap(getWorkflowRun("onboarding", run.id))).toMatchObject({ status: "queued" })
})

it("captures Cloudflare cancellations", async () => {
  setWorkflowRuntimeConfig({ driver: "cloudflare" })
  const run = await unwrap(startWorkflow("onboarding", {}))
  expect(await unwrap(cancelWorkflow("onboarding", run.id))).toMatchObject({ provider: "cloudflare", status: "cancelled" })
  expect(await unwrap(getWorkflowRun("onboarding", run.id))).toMatchObject({ status: "cancelled" })
})

it("rejects caller run IDs for native Vercel Workflows but captures supported starts and cancellations", async () => {
  setWorkflowRuntimeConfig({ driver: "vercel" })
  setWorkflowRuntimeRegistry({ onboarding: async () => ({ handler, native: handler }) })
  expect(await startWorkflow("onboarding", {}, { id: "custom" })).toMatchObject([{ code: "WORKFLOW_RUN_ID_UNSUPPORTED" }, undefined])
  expect(mode.peek("workflow")).toBeUndefined()
  const run = await unwrap(startWorkflow("onboarding", {}))
  expect(await unwrap(cancelWorkflow("onboarding", run.id))).toMatchObject({ status: "cancelled" })
})

it.each(["cloudflare", "openworkflow", "vercel"] as const)("rejects %s signals without loading a provider", async (provider) => {
  setWorkflowRuntimeConfig({ driver: provider })
  const loadProvider = vi.fn(async () => { throw new Error("provider must not load") })
  setVercelWorkflowRuntimeLoader(loadProvider)
  expect(await resumeWorkflow("valid-hook-token", {})).toMatchObject([{ code: "WORKFLOW_OPERATION_UNSUPPORTED", data: { operation: "signals", provider } }, undefined])
  expect(loadProvider).not.toHaveBeenCalled()
})
