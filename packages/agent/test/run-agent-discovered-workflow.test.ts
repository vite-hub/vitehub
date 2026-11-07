import { afterEach, expect, it, vi } from "vitest"

import { defineAgent, defineCapability, runAgent, workflow } from "../src/index.ts"
import { markDiscoveredAgentName } from "../src/internal/discovered-agent-name.ts"
import { setAgentWorkflowRuntimeLoaders } from "../src/internal/workflow-runtime-loaders.ts"

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

afterEach(() => {
  setAgentWorkflowRuntimeLoaders({
    state: () => import("@vite-hub/workflow/runtime/state"),
    workflow: () => import("@vite-hub/workflow"),
  })
})

/** A host with one discovered Workflow, `hello`. Returns the Workflows that runs start, and whether each brought its own handler. */
function discoveredWorkflowHost() {
  const started: Array<{ inline: boolean, name: string }> = []
  setAgentWorkflowRuntimeLoaders({
    state: async () => ({
      ...await import("@vite-hub/workflow/runtime/state"),
      getWorkflowRuntimeConfig: () => ({ provider: "openworkflow" as const }),
      getWorkflowRuntimeRegistry: () => ({ hello: async () => ({ handler: () => undefined }) }),
      loadWorkflowDefinition: async () => ({ handler: () => undefined }),
    }),
    workflow: async () => ({
      ...await import("@vite-hub/workflow"),
      // SAFETY: This fixture supplies the Workflow dispatch boundary under test.
      createWorkflow: ((name: string, handler?: unknown) => ({
        name,
        run: async () => {
          started.push({ inline: Boolean(handler), name })
          return { id: "hello-run", provider: "openworkflow", status: "queued" }
        },
      })) as never,
    }),
  })
  return started
}

const runtime = () => ({ memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() })
function hello() {
  const agent = defineAgent({ driver: { run: () => "inline" } })
  markDiscoveredAgentName(agent, "hello")
  return agent
}

it("starts the discovered Workflow of a discovered Agent from a caller without a host identity", async () => {
  const started = discoveredWorkflowHost()

  await expect(runAgent(hello(), runtime(), { prompt: "ping" })).resolves.toMatchObject({ id: "hello-run" })
  expect(started).toEqual([{ inline: false, name: "hello" }])
})

it("runs a discovered Agent inline when the call passes invocation Capabilities", async () => {
  const started = discoveredWorkflowHost()
  const capability = defineCapability({ id: "invocation-probe", tools: () => ({}) })

  await expect(runAgent(hello(), runtime(), { prompt: "ping" }, { capabilities: [capability] })).resolves.toBe("inline")
  expect(started).toEqual([])
})

it("rejects a named Agent that the host did not discover when it uses a discovered Workflow name", async () => {
  const started = discoveredWorkflowHost()
  const impostor = defineAgent({ name: "hello", runtime: workflow("hello"), driver: { run: () => "impostor" } })

  await expect(runAgent(impostor, runtime(), { prompt: "ping" })).rejects.toMatchObject({ code: "AGENT_R0422" })
  expect(started).toEqual([])
})
