import { afterEach, expect, it, vi } from "vitest"

import { defineAgent, defineCapability, runAgent, startAgentInvocation, agentWorkflow } from "../src/index.ts"
import { markDiscoveredAgentName } from "../src/internal/discovered-agent-name.ts"
import { setAgentWorkflowRuntimeLoaders } from "../src/internal/workflow-runtime-loaders.ts"

vi.mock("#vitehub/agent/registry", () => ({ default: {}, loadAgentHost: async () => {} }))

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
      getWorkflowRuntimeConfig: () => ({ driver: "openworkflow" as const }),
      getWorkflowRuntimeRegistry: () => ({ hello: async () => ({ handler: () => undefined }) }),
      loadWorkflowDefinition: async () => ({ handler: () => undefined }),
    }),
    workflow: async () => ({
      ...await import("@vite-hub/workflow"),
      // SAFETY: This fixture supplies the Workflow dispatch boundary under test.
      createWorkflow: ((name: string, handler?: unknown) => ({
        name,
        start: async () => {
          started.push({ inline: Boolean(handler), name })
          return [undefined, { id: "hello-run", provider: "openworkflow", status: "queued" }]
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

  await expect(startAgentInvocation(hello(), runtime(), { prompt: "ping" })).resolves.toMatchObject({ id: "hello-run" })
  expect(started).toEqual([{ inline: false, name: "hello" }])
})

it.each([false, true])("runs a discovered Agent inline with runAgent() (explicit Workflow: %s)", async (explicit) => {
  const started = discoveredWorkflowHost()
  const agent = defineAgent({ ...(explicit ? { runtime: agentWorkflow("hello") } : {}), driver: { run: () => "inline" } })
  markDiscoveredAgentName(agent, "hello")

  await expect(runAgent(agent, { prompt: "ping" }, { runtimeContext: runtime() })).resolves.toMatchObject([
    undefined, { output: "inline", text: "inline" },
  ])
  expect(started).toEqual([])
})

it("runs a discovered Agent inline when the call passes invocation Capabilities", async () => {
  const started = discoveredWorkflowHost()
  const capability = defineCapability({ id: "invocation-probe", tools: () => ({}) })

  await expect(runAgent(hello(), { prompt: "ping" }, { capabilities: [capability], runtimeContext: runtime() })).resolves.toMatchObject([
    undefined, { output: "inline", text: "inline" },
  ])
  expect(started).toEqual([])
})

it("rejects a named Agent that the host did not discover when it uses a discovered Workflow name", async () => {
  const started = discoveredWorkflowHost()
  const impostor = defineAgent({ name: "hello", runtime: agentWorkflow("hello"), driver: { run: () => "impostor" } })

  await expect(startAgentInvocation(impostor, runtime(), { prompt: "ping" })).rejects.toMatchObject({ code: "AGENT_R0422" })
  expect(started).toEqual([])
})

it.each(["constructor", "toString", "__proto__"])("starts an inline Workflow named %s when the registry has no own entry", async (name) => {
  const started = discoveredWorkflowHost()
  const agent = defineAgent({ runtime: agentWorkflow(name), driver: { run: () => "inline" } })

  await expect(startAgentInvocation(agent, runtime(), { prompt: "ping" })).resolves.toMatchObject({ id: "hello-run" })
  expect(started).toEqual([{ inline: true, name }])
})

it.each(["@vite-hub/workflow", "@vite-hub/workflow/runtime/state"])("runs a discovered Agent inline when the app does not install %s", async (specifier) => {
  // The message that Node gives when an optional peer is absent from the deployed app.
  const missing = () => Promise.reject(Object.assign(new Error(`Cannot find package '${specifier}' imported from /app/.output/server/_libs/agent.mjs`), { code: "ERR_MODULE_NOT_FOUND" }))
  setAgentWorkflowRuntimeLoaders({ state: missing, workflow: missing })
  const run = vi.fn(() => "inline")
  const agent = defineAgent({ driver: { run } })
  markDiscoveredAgentName(agent, "hello")

  await expect(startAgentInvocation(agent, { ...runtime(), agentIdentity: { name: "hello" } }, { prompt: "ping" })).resolves.toBeDefined()
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
})

it("still fails a discovered Agent when a dependency of @vite-hub/workflow is missing", async () => {
  const broken = () => Promise.reject(Object.assign(new Error("Cannot find package 'openworkflow' imported from /app/node_modules/@vite-hub/workflow/dist/index.js"), { code: "ERR_MODULE_NOT_FOUND" }))
  setAgentWorkflowRuntimeLoaders({ state: broken, workflow: broken })
  const run = vi.fn(() => "inline")
  const agent = defineAgent({ driver: { run } })
  markDiscoveredAgentName(agent, "hello")

  await expect(startAgentInvocation(agent, { ...runtime(), agentIdentity: { name: "hello" } }, { prompt: "ping" })).rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND" })
  expect(run).not.toHaveBeenCalled()
})
