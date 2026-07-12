import type { AgentInvocationContextStore } from "./types.ts"
import type { WorkspaceDiff } from "@vite-hub/workspace"

export interface ActiveHarnessWorkspaceFiles {
  readFile(path: string): Promise<ActiveHarnessWorkspaceFileRead>
}

export interface ActiveHarnessWorkspaceFileRead {
  active: true
  body: Uint8Array | undefined
}

const activeHarnessWorkspaceFiles = new WeakMap<AgentInvocationContextStore, ActiveHarnessWorkspaceFiles>()
const harnessWorkspaceDiffs = new WeakMap<AgentInvocationContextStore, WorkspaceDiff>()

export function setActiveHarnessWorkspaceFiles(context: AgentInvocationContextStore, files: ActiveHarnessWorkspaceFiles | undefined) {
  if (files) activeHarnessWorkspaceFiles.set(context, files)
  else activeHarnessWorkspaceFiles.delete(context)
}

export async function readActiveHarnessWorkspaceFile(context: AgentInvocationContextStore, path: string): Promise<ActiveHarnessWorkspaceFileRead | undefined> {
  return await activeHarnessWorkspaceFiles.get(context)?.readFile(path)
}

export function setHarnessWorkspaceDiff(context: AgentInvocationContextStore, diff: WorkspaceDiff) {
  harnessWorkspaceDiffs.set(context, diff)
}

export function readHarnessWorkspaceDiff(context: AgentInvocationContextStore): WorkspaceDiff | undefined {
  return harnessWorkspaceDiffs.get(context)
}

export function clearHarnessWorkspaceDiff(context: AgentInvocationContextStore) {
  harnessWorkspaceDiffs.delete(context)
}
