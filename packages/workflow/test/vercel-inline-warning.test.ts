import { afterEach, expect, it, vi } from "vitest"

import { createWorkflow, startWorkflow } from "../src/runtime/client.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

import { unwrap } from "./unwrap.ts"

afterEach(() => {
  resetWorkflowRuntime()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it("warns once when a Workflow made in code runs inline on Vercel", async () => {
  vi.stubEnv("NODE_ENV", "production")
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  setWorkflowRuntimeConfig({ driver: "vercel" })
  createWorkflow("in-code", async ({ payload }) => payload)

  expect(await unwrap(startWorkflow("in-code", 1))).toMatchObject({ metadata: { mode: "inline" }, provider: "vercel" })
  await unwrap(startWorkflow("in-code", 2))

  expect(warn).toHaveBeenCalledOnce()
  expect(warn.mock.calls[0]?.[0]).toBe("[vitehub:workflow] The Workflow \"in-code\" is not a discovered file, so Workflow DevKit cannot run it. Its runs execute inline in this process and are not durable. Move it to server/workflows/ to make it durable.")
})

it("runs Agent turns inline on Vercel without the warning", async () => {
  vi.stubEnv("NODE_ENV", "production")
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  setWorkflowRuntimeConfig({ driver: "vercel" })
  setWorkflowRuntimeRegistry({
    "agent-turn": async () => ({ default: { handler: async () => "turn", internalAgentWorkflow: true } }),
  })

  expect(await unwrap(startWorkflow("agent-turn"))).toMatchObject({ metadata: { mode: "inline" }, provider: "vercel" })
  expect(warn).not.toHaveBeenCalled()
})
