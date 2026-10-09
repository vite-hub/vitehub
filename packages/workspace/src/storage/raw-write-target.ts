import type { WritableWorkspaceFacade } from "../core/use.ts"
import type { MkdirOptions, RmOptions, WriteFileOptions, WorkspaceContent } from "../core/types.ts"

export type WorkspaceRawWriteTarget = {
  writeFile(path: string, content: WorkspaceContent, options?: WriteFileOptions): Promise<string>
  mkdir(path: string, options?: MkdirOptions): Promise<void>
  rm(path: string, options?: RmOptions): Promise<void>
}

const workspaceRawWriteTargets = new WeakMap<object, WorkspaceRawWriteTarget>()

export function setWorkspaceRawWriteTarget(workspace: WritableWorkspaceFacade, target: WorkspaceRawWriteTarget): void {
  workspaceRawWriteTargets.set(workspace, target)
}

export function resolveWorkspaceRawWriteTarget(workspace: WritableWorkspaceFacade): WorkspaceRawWriteTarget | undefined {
  return workspaceRawWriteTargets.get(workspace)
}
