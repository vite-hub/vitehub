import { createWorkspaceTools } from "../ai.ts"
import type { WorkspaceReadOperations } from "../ai.ts"
import type { ToolSet } from "ai"
import { createReadonlyFs, createWorkspaceFileRuntime } from "./use.ts"
import type { ReadonlyWorkspaceFacade, WritableWorkspaceFacade, UseWorkspaceOptions, WorkspaceFacadeToolOptions, WritableWorkspaceFacadeToolOptions, WorkspaceReadTools, WorkspaceWriteTools } from "./use.ts"
import type { WorkspaceName } from "./types.ts"

function toReadOperations(options: WorkspaceFacadeToolOptions | undefined): WorkspaceReadOperations {
  return { list: options?.list, materialize: options?.materialize ?? true, read: options?.read, search: options?.search }
}

function toWriteOperations(options: WritableWorkspaceFacadeToolOptions | undefined) {
  return {
    ...toReadOperations(options),
    write: {
      appendFile: options?.appendFile !== false,
      copyPath: options?.copyPath !== false,
      deletePath: options?.deletePath !== false,
      makeDir: options?.makeDir !== false,
      movePath: options?.movePath !== false,
      writeFile: options?.writeFile !== false,
    },
  }
}

function createDefaultToolSet<TOptions, TDefaultTools extends ToolSet>(
  createTools: (options?: TOptions) => ToolSet,
) {
  return createTools() as TDefaultTools
}

function emptyTools(): ToolSet {
  return {}
}

export function useWorkspace<Name extends WorkspaceName>(name: Name): ReadonlyWorkspaceFacade<Name>
export function useWorkspace<Name extends WorkspaceName>(name: Name, options: UseWorkspaceOptions & { mode?: "read" }): ReadonlyWorkspaceFacade<Name>
export function useWorkspace<Name extends WorkspaceName>(name: Name, options: UseWorkspaceOptions & { mode: "write" }): WritableWorkspaceFacade<Name>
export function useWorkspace<Name extends WorkspaceName>(name: Name, options?: UseWorkspaceOptions): ReadonlyWorkspaceFacade<Name> | WritableWorkspaceFacade<Name> {
  const runtime = createWorkspaceFileRuntime(name, options)
  if (runtime.mode === "write") {
    const createTools = (opts?: WritableWorkspaceFacadeToolOptions) => createWorkspaceTools(runtime.workspace, {
      broadSearchPaths: opts?.broadSearchPaths,
      cwd: opts?.cwd,
      maxShellCalls: opts?.maxShellCalls,
      maxOutputLength: opts?.maxOutputLength,
      operations: toWriteOperations(opts),
      sourceRequests: opts?.sourceRequests,
      timeout: opts?.timeout,
    })
    const createReadTools = (opts?: WorkspaceFacadeToolOptions) => createWorkspaceTools(createReadonlyFs(name, runtime.workspace), {
      broadSearchPaths: opts?.broadSearchPaths,
      cwd: opts?.cwd,
      maxShellCalls: opts?.maxShellCalls,
      maxOutputLength: opts?.maxOutputLength,
      operations: toReadOperations(opts),
      sourceRequests: opts?.sourceRequests,
      timeout: opts?.timeout,
    })
    const tools = createDefaultToolSet<
      WritableWorkspaceFacadeToolOptions,
      WorkspaceWriteTools
    >(createTools) as WritableWorkspaceFacade<Name>["tools"]
    tools.inspect = createReadTools as WritableWorkspaceFacade<Name>["tools"]["inspect"]
    tools.write = createTools as WritableWorkspaceFacade<Name>["tools"]["write"]
    tools.none = emptyTools
    return Object.assign(runtime.facade, { tools })
  }
  const createTools = (opts?: WorkspaceFacadeToolOptions) => createWorkspaceTools(runtime.facade.fs, {
    broadSearchPaths: opts?.broadSearchPaths,
    cwd: opts?.cwd,
    maxShellCalls: opts?.maxShellCalls,
    maxOutputLength: opts?.maxOutputLength,
    operations: toReadOperations(opts),
    sourceRequests: opts?.sourceRequests,
    timeout: opts?.timeout,
  })
  const tools = createDefaultToolSet<
    WorkspaceFacadeToolOptions,
    WorkspaceReadTools
  >(createTools) as ReadonlyWorkspaceFacade<Name>["tools"]
  tools.inspect = createTools as ReadonlyWorkspaceFacade<Name>["tools"]["inspect"]
  tools.none = emptyTools
  return Object.assign(runtime.facade, { tools })
}
