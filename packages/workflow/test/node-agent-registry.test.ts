import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, expect, it } from "vitest"

import { workflowDevGeneratedDir } from "../src/internal/dev-registry.ts"
import { getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"
import { hubWorkflow } from "../src/vite.ts"

import type { WorkflowDefinitionRegistry } from "../src/types.ts"

let root: string | undefined

afterEach(async () => {
  Reflect.deleteProperty(globalThis, "__vitehubAgentTurns")
  await resetOpenWorkflowRuntime()
  resetWorkflowRuntime()
  if (root) await rm(root, { force: true, recursive: true })
  root = undefined
})

type ConfigHook = (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>

/**
 * An app with one discovered Agent. The Agent runtime files are small doubles: the test checks that the Node registry
 * gives OpenWorkflow the Agent Workflow, not how the Agent package runs a turn.
 */
async function createAgentApp() {
  root = await mkdtemp(join(tmpdir(), "vitehub-workflow-node-agent-"))
  await writeFile(join(root, "package.json"), "{\"type\":\"module\"}\n")
  await mkdir(join(root, "server/agents"), { recursive: true })
  await mkdir(join(root, "server/utils"), { recursive: true })
  await writeFile(join(root, "server/utils/define-agent.ts"), "export const defineAgent = agent => agent\n")
  await writeFile(join(root, "server/agents/helper.ts"), "import { defineAgent } from '../utils/define-agent.ts'\n\nexport default defineAgent({ name: 'helper' })\n")
  const agentDir = join(root, "agent-runtime")
  await mkdir(agentDir, { recursive: true })
  const modules = {
    index: join(agentDir, "index.mjs"),
    runtimeWorkflow: join(agentDir, "workflow.mjs"),
    serverInternal: join(agentDir, "internal.mjs"),
  }
  await writeFile(modules.index, "export const agentWithColocatedInstructions = agent => agent\n")
  await writeFile(modules.runtimeWorkflow, [
    "export const agentWithColocatedSkills = agent => agent",
    "export const workspaceAgentWithSourceRoot = agent => agent",
    "export async function runAgentWorkflowDefinition(agent, context) {",
    "  globalThis.__vitehubAgentTurns.push({ agent: agent.name, identity: context.payload.agentIdentity.name, prompt: context.payload.prompt })",
    "  return { ok: true }",
    "}",
    "",
  ].join("\n"))
  await writeFile(modules.serverInternal, [
    "export function installAgentChannelDeliveryWorkflowResolver() {}",
    "export function setAgentWorkflowRuntimeLoaders() {}",
    "export async function runAgentInline() {}",
    "",
  ].join("\n"))
  return { modules, projectRoot: root }
}

it.each(["build", "serve"] as const)("puts discovered Agent Workflows in the Node registry for a %s, and a worker runs a queued turn", async (command) => {
  const { modules, projectRoot } = await createAgentApp()
  const plugin = hubWorkflow({}, { hosting: "node-server" })
  const hook = plugin.config
  if (!hook || typeof hook === "function") throw new TypeError("Expected config object hook")
  const plugins = [{ name: "@vite-hub/agent/vite", vitehub: { agent: { workflowModules: modules, transformWorkflowRegistry: (code: string) => "// Agent runtime setup installed\n" + code } } }]
  await (hook.handler as unknown as ConfigHook)({ plugins, root: projectRoot }, { command, mode: command === "build" ? "production" : "development" })
  await (plugin.configResolved as (config: unknown) => Promise<void>)({ plugins, root: projectRoot })

  const registryFile = join(projectRoot, workflowDevGeneratedDir, "dev-registry.mjs")
  const { default: registry } = await import(/* @vite-ignore */ `${pathToFileURL(registryFile).href}?t=${command}`) as { default: WorkflowDefinitionRegistry }
  expect(await readFile(registryFile, "utf8")).toContain("// Agent runtime setup installed")
  // The turn and its recovery run are both OpenWorkflow runs, so a worker must know both definitions.
  expect(Object.keys(registry).sort(), await readFile(registryFile, "utf8")).toEqual(["helper", "vitehub-agent-invocation-recovery-helper"])

  setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
  setWorkflowRuntimeRegistry(registry)
  const started = await startWorkflow("helper", { agentIdentity: { name: "helper" }, prompt: "hello" })
  expect(await getWorkflowRun("helper", started.id)).toMatchObject({ status: "queued" })

  const turns: unknown[] = []
  Reflect.set(globalThis, "__vitehubAgentTurns", turns)
  const worker = await createOpenWorkflowWorker()
  await worker.tick()
  await worker.stop()

  expect(await getWorkflowRun("helper", started.id)).toMatchObject({ status: "completed" })
  expect(turns).toEqual([{ agent: "helper", identity: "helper", prompt: "hello" }])
})

it("keeps Agent Workflows out of the registry of a Workflow provider that does not run a worker", async () => {
  const { modules, projectRoot } = await createAgentApp()
  const plugin = hubWorkflow({}, { hosting: "deno-server" })
  const hook = plugin.config
  if (!hook || typeof hook === "function") throw new TypeError("Expected config object hook")
  const plugins = [{ name: "@vite-hub/agent/vite", vitehub: { agent: { workflowModules: modules, transformWorkflowRegistry: (code: string) => "// Agent runtime setup installed\n" + code } } }]
  await (hook.handler as unknown as ConfigHook)({ plugins, root: projectRoot }, { command: "serve", mode: "development" })
  await (plugin.configResolved as (config: unknown) => Promise<void>)({ plugins, root: projectRoot })

  const registry = await readFile(join(projectRoot, workflowDevGeneratedDir, "dev-registry.mjs"), "utf8")
  expect(registry).not.toContain("helper")
})
