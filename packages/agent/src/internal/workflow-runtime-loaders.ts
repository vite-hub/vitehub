const workflowSpecifier = "@vite-hub/workflow"
const workflowRuntimeStateSpecifier = "@vite-hub/workflow/runtime/state"

type WorkflowModule = typeof import("@vite-hub/workflow")
type WorkflowRuntimeStateModule = typeof import("@vite-hub/workflow/runtime/state")

export interface AgentWorkflowRuntimeLoaders {
  state: () => Promise<WorkflowRuntimeStateModule>
  workflow: () => Promise<WorkflowModule>
}

let workflowRuntimeLoaders: AgentWorkflowRuntimeLoaders = {
  state: () => import(/* @vite-ignore */ workflowRuntimeStateSpecifier),
  workflow: () => import(/* @vite-ignore */ workflowSpecifier),
}

export function setAgentWorkflowRuntimeLoaders(loaders: AgentWorkflowRuntimeLoaders): void {
  workflowRuntimeLoaders = loaders
}

export function loadAgentWorkflowModule(): Promise<WorkflowModule> {
  return workflowRuntimeLoaders.workflow()
}

export function loadAgentWorkflowRuntimeStateModule(): Promise<WorkflowRuntimeStateModule> {
  return workflowRuntimeLoaders.state()
}
