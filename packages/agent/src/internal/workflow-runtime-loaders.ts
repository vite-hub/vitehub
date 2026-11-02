import { agentDiagnostics } from "../agent-diagnostics.ts"
// Module-level specifiers stay variables in the built package. The bundler inlines a local constant, and Vite then
// resolves the literal import while it analyzes the module, even when the app never calls the loader.
const workflowSpecifier = "@vite-hub/workflow"
const workflowRuntimeStateSpecifier = "@vite-hub/workflow/runtime/state"
const blobSpecifier = "@vite-hub/blob"
const databaseSpecifier = "@vite-hub/database/drizzle"

type WorkflowModule = typeof import("@vite-hub/workflow")
type WorkflowRuntimeStateModule = typeof import("@vite-hub/workflow/runtime/state")

export interface AgentWorkflowRuntimeLoaders {
  state: () => Promise<WorkflowRuntimeStateModule>
  workflow: () => Promise<WorkflowModule>
}

export interface AgentWorkflowCapabilityLoaders {
  blob?: () => Promise<unknown> | unknown
  console?: () => Promise<unknown> | unknown
  db?: () => Promise<unknown> | unknown
}

let workflowRuntimeLoaders: AgentWorkflowRuntimeLoaders = {
  state: () => import(/* @vite-ignore */ workflowRuntimeStateSpecifier),
  workflow: () => import(/* @vite-ignore */ workflowSpecifier),
}
let workflowCapabilityLoaders: AgentWorkflowCapabilityLoaders = {}

export function setAgentWorkflowRuntimeLoaders(loaders: AgentWorkflowRuntimeLoaders): void {
  workflowRuntimeLoaders = loaders
}

export function setAgentWorkflowCapabilityLoaders(loaders: AgentWorkflowCapabilityLoaders): void {
  workflowCapabilityLoaders = loaders
}

function getAgentWorkflowCapabilityLoader(name: string): (() => Promise<unknown> | unknown) | undefined {
  switch (name) {
    case "blob": return workflowCapabilityLoaders.blob
    case "console": return workflowCapabilityLoaders.console
    case "db": return workflowCapabilityLoaders.db
    default: return undefined
  }
}

export async function loadConfiguredAgentWorkflowCapabilities(
  mask: Record<string, boolean> = {},
): Promise<Record<string, unknown>> {
  const entries = await Promise.all(Object.entries(mask).map(async ([name, enabled]) => {
    if (!enabled) return [name, false] as const
    const load = getAgentWorkflowCapabilityLoader(name)
    return load ? [name, await load()] as const : undefined
  }))
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, unknown] => entry !== undefined))
}

export function loadAgentWorkflowModule(): Promise<WorkflowModule> {
  return workflowRuntimeLoaders.workflow()
}

export function loadAgentWorkflowRuntimeStateModule(): Promise<WorkflowRuntimeStateModule> {
  return workflowRuntimeLoaders.state()
}

export async function loadAgentWorkflowBlobPrimitive(): Promise<unknown> {
  if (workflowCapabilityLoaders.blob) return await workflowCapabilityLoaders.blob()
  // SAFETY: The official Blob package export is the primitive registered by generated Workflow hosts.
  return ((await import(/* @vite-ignore */ blobSpecifier)) as { blob: unknown }).blob
}

export async function loadAgentWorkflowConsolePrimitive(): Promise<unknown> {
  const load = workflowCapabilityLoaders.console
  if (!load) throw agentDiagnostics.AGENT_R0603({ message: "[vitehub] The Console Workflow capability requires a generated runtime loader." })
  return await load()
}

export async function loadAgentWorkflowDatabasePrimitive(): Promise<unknown> {
  if (workflowCapabilityLoaders.db) return await workflowCapabilityLoaders.db()
  // SAFETY: The official Database package export is the primitive registered by generated Workflow hosts.
  return ((await import(/* @vite-ignore */ databaseSpecifier)) as { agentDb: unknown }).agentDb
}
