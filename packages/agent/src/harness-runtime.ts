import type { AgentInvocationContextStore } from "./types.ts"

export interface ActiveHarnessWorkspaceFiles {
  readFile(path: string): Promise<ActiveHarnessWorkspaceFileRead>
}

export interface ActiveHarnessWorkspaceFileRead {
  active: true
  body: Uint8Array | undefined
}

const activeHarnessWorkspaceFiles = new WeakMap<AgentInvocationContextStore, ActiveHarnessWorkspaceFiles>()

export function setActiveHarnessWorkspaceFiles(context: AgentInvocationContextStore, files: ActiveHarnessWorkspaceFiles | undefined) {
  if (files) activeHarnessWorkspaceFiles.set(context, files)
  else activeHarnessWorkspaceFiles.delete(context)
}

export async function readActiveHarnessWorkspaceFile(context: AgentInvocationContextStore, path: string): Promise<ActiveHarnessWorkspaceFileRead | undefined> {
  return await activeHarnessWorkspaceFiles.get(context)?.readFile(path)
}
