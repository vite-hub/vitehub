import type { AgentInvocationContextStore } from "./types.ts"
import type { ExecOptions, ExecResult, WorkspaceDiff } from "@vite-hub/workspace"

export interface ActiveAgentWorkspaceFiles {
  readFile(path: string): Promise<ActiveAgentWorkspaceFileRead>
}

export interface ActiveAgentWorkspaceFileRead {
  active: true
  body: Uint8Array | undefined
}

const activeWorkspaceFiles = new WeakMap<AgentInvocationContextStore, ActiveAgentWorkspaceFiles>()
const activeWorkspaceCommands = new WeakMap<AgentInvocationContextStore, (command: string, args?: string[], options?: ExecOptions) => Promise<ExecResult>>()
const workspaceDiffs = new WeakMap<AgentInvocationContextStore, WorkspaceDiff>()

export function setActiveAgentWorkspaceFiles(context: AgentInvocationContextStore, files: ActiveAgentWorkspaceFiles) {
  activeWorkspaceFiles.set(context, files)
  return () => {
    if (activeWorkspaceFiles.get(context) === files) activeWorkspaceFiles.delete(context)
  }
}

export function setActiveAgentWorkspaceCommands(
  context: AgentInvocationContextStore,
  execute: (command: string, args?: string[], options?: ExecOptions) => Promise<ExecResult>,
) {
  activeWorkspaceCommands.set(context, execute)
  return () => {
    if (activeWorkspaceCommands.get(context) === execute) activeWorkspaceCommands.delete(context)
  }
}

export function activeAgentWorkspaceCommands(context: AgentInvocationContextStore) {
  return activeWorkspaceCommands.get(context)
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
