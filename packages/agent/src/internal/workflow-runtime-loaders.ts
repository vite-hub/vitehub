const workflowSpecifier = "@vite-hub/workflow"
const workflowRuntimeStateSpecifier = "@vite-hub/workflow/runtime/state"

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

export async function loadConfiguredAgentWorkflowCapabilities(
  mask: Record<string, boolean> = {},
): Promise<Record<string, unknown>> {
  const entries = await Promise.all(Object.entries(mask).map(async ([name, enabled]) => {
    if (!enabled) return [name, false] as const
    const load = workflowCapabilityLoaders[name as keyof AgentWorkflowCapabilityLoaders]
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
  const packageName: string = "@vite-hub/blob"
  // SAFETY: The official Blob package export is the primitive registered by generated Workflow hosts.
  return ((await import(/* @vite-ignore */ packageName)) as { blob: unknown }).blob
}

export async function loadAgentWorkflowConsolePrimitive(): Promise<unknown> {
  if (workflowCapabilityLoaders.console) return await workflowCapabilityLoaders.console()
  const packageName: string = "vite-hub/console/server"
  // SAFETY: The full distribution's Console server export is the primitive registered by generated Workflow hosts.
  return ((await import(/* @vite-ignore */ packageName)) as { console: unknown }).console
}

export async function loadAgentWorkflowDatabasePrimitive(): Promise<unknown> {
  if (workflowCapabilityLoaders.db) return await workflowCapabilityLoaders.db()
  const packageName: string = "@vite-hub/database/drizzle"
  // SAFETY: The official Database package export is the primitive registered by generated Workflow hosts.
  return ((await import(/* @vite-ignore */ packageName)) as { agentDb: unknown }).agentDb
}
