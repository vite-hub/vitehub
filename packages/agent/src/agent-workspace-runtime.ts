import type { AgentInvocationContextStore } from "./types.ts"
import type { WorkspaceDiff } from "@vite-hub/workspace"

export interface ActiveAgentWorkspaceFiles {
  readFile(path: string): Promise<ActiveAgentWorkspaceFileRead>
}

export interface ActiveAgentWorkspaceFileRead {
  active: true
  body: Uint8Array | undefined
}

const activeWorkspaceFiles = new WeakMap<AgentInvocationContextStore, ActiveAgentWorkspaceFiles>()
const workspaceDiffs = new WeakMap<AgentInvocationContextStore, WorkspaceDiff>()

export function setActiveAgentWorkspaceFiles(context: AgentInvocationContextStore, files: ActiveAgentWorkspaceFiles | undefined) {
  if (files) activeWorkspaceFiles.set(context, files)
  else activeWorkspaceFiles.delete(context)
}

export async function readActiveAgentWorkspaceFile(context: AgentInvocationContextStore, path: string): Promise<ActiveAgentWorkspaceFileRead | undefined> {
  return await activeWorkspaceFiles.get(context)?.readFile(path)
}

export function setAgentWorkspaceDiff(context: AgentInvocationContextStore, diff: WorkspaceDiff) {
  workspaceDiffs.set(context, diff)
}

export function readAgentWorkspaceDiff(context: AgentInvocationContextStore): WorkspaceDiff | undefined {
  return workspaceDiffs.get(context)
}

export function clearAgentWorkspaceDiff(context: AgentInvocationContextStore) {
  workspaceDiffs.delete(context)
}
