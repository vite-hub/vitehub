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

export function loadAgentWorkflowModule(): Promise<WorkflowModule> {
  return workflowRuntimeLoaders.workflow()
}

export function loadAgentWorkflowRuntimeStateModule(): Promise<WorkflowRuntimeStateModule> {
  return workflowRuntimeLoaders.state()
}

export async function loadAgentWorkflowBlobPrimitive(): Promise<unknown> {
  if (workflowCapabilityLoaders.blob) return await workflowCapabilityLoaders.blob()
  const packageName: string = "@vite-hub/blob"
  return ((await import(/* @vite-ignore */ packageName)) as { blob: unknown }).blob
}

export async function loadAgentWorkflowDatabasePrimitive(): Promise<unknown> {
  if (workflowCapabilityLoaders.db) return await workflowCapabilityLoaders.db()
  const packageName: string = "@vite-hub/database/drizzle"
  return ((await import(/* @vite-ignore */ packageName)) as { agentDb: unknown }).agentDb
}
