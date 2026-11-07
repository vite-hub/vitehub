import { afterAll, expect, it } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import { cancelWorkflow, createWorkflow, deferWorkflow, getWorkflowRun, runWorkflow } from "../src/runtime/client.ts"
import { setWorkflowRuntimeConfig } from "../src/runtime/state.ts"

const mode = enableViteHubTestMode()

afterAll(async () => {
  await mode.reset()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
  setWorkflowRuntimeConfig(undefined)
})

it("records every start without a Definition or a provider, and a reset empties the list", async () => {
  setWorkflowRuntimeConfig({ provider: "cloudflare" })

  const run = await runWorkflow("onboarding", { userId: 1 }, { id: "run-1" })
  expect(run).toEqual({ id: "run-1", payload: { userId: 1 }, provider: "cloudflare", status: "queued" })
  // The same id starts one run.
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
  expect(await getWorkflowRun("onboarding", "missing")).toEqual({ id: "missing", provider: "cloudflare", status: "unknown" })

  await mode.reset()
  expect(mode.peek("workflow")).toBeUndefined()
})
