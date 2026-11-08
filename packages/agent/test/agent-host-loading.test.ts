import { afterEach, expect, it, vi } from "vitest"
import { installAgentRegistry } from "#vitehub/agent/registry"
import { defineAgent, runAgent, startAgentInvocation } from "../src/index.ts"
import { setAgentWorkflowRuntimeLoaders } from "../src/internal/workflow-runtime-loaders.ts"

afterEach(() => {
  installAgentRegistry({ default: {}, metadata: {} })
  setAgentWorkflowRuntimeLoaders({
    state: () => import("@vite-hub/workflow/runtime/state"),
    workflow: () => import("@vite-hub/workflow"),
  })
})

it.each(["runAgent", "startAgentInvocation"] as const)("loads the cold host before %s selects a Workflow", async (method) => {
  const run = vi.fn(() => "inline output")
  const agent = defineAgent({ driver: { run } })
  const context = { agentIdentity: { name: `cold-${method}` }, runtime: "unknown" as const, waitUntil: vi.fn() }
  const providerRun = vi.fn(async () => ({ id: `workflow-${method}`, provider: "openworkflow", status: "queued" }))
  const staleState = vi.fn(async () => { throw new Error("Workflow state loaded before Agent host") })
  const staleWorkflow = vi.fn(async () => { throw new Error("Workflow module loaded before Agent host") })
  setAgentWorkflowRuntimeLoaders({ state: staleState, workflow: staleWorkflow })
  const loadAgentHost = vi.fn(async () => {
    setAgentWorkflowRuntimeLoaders({
      state: async () => ({
        ...await import("@vite-hub/workflow/runtime/state"),
        getWorkflowRuntimeConfig: () => ({ provider: "openworkflow" as const }),
      }),
      workflow: async () => ({
        ...await import("@vite-hub/workflow"),
        // SAFETY: The fixture only uses the provider's Workflow run operation.
        createWorkflow: () => ({ start: providerRun }),
      }) as never,
    })
  })
  installAgentRegistry({ default: {}, metadata: {}, loadAgentHost })

  if (method === "runAgent") {
    await expect(runAgent(agent, context, { prompt: "Run before any request" }))
      .resolves.toMatchObject({ id: `workflow-${method}`, provider: "openworkflow" })
  }
  else {
    const invocation = await startAgentInvocation(agent, context, { prompt: "Run before any request" })
    expect(invocation.id).toBe(`workflow-${method}`)
  }
  expect(loadAgentHost).toHaveBeenCalledOnce()
  expect(staleState).not.toHaveBeenCalled()
  expect(staleWorkflow).not.toHaveBeenCalled()
  expect(providerRun).toHaveBeenCalledOnce()
  expect(run).not.toHaveBeenCalled()
})

it.each([new Error("Host failed to load"), "Host failed to load"])("returns a standalone error tuple when the host fails to load: %s", async (failure) => {
  const run = vi.fn(() => "inline output")
  const agent = defineAgent({ driver: { run }, runtime: false })
  installAgentRegistry({ default: {}, metadata: {}, loadAgentHost: async () => { throw failure } })

  const [error, result] = await runAgent(agent, { prompt: "Run before any request" })
  expect(result).toBeNull()
  expect(error?.message).toBe("Host failed to load")
  if (failure instanceof Error) expect(error).toBe(failure)
  else expect(error?.cause).toBe(failure)
  expect(run).not.toHaveBeenCalled()
})
