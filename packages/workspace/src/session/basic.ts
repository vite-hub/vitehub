import { WorkspaceError } from "../core/errors.ts"

import type { ExecOptions, ExecResult, Workspace, WorkspaceSession } from "../core/types.ts"

function unsupportedExec(): never {
  throw new WorkspaceError("[vitehub] Workspace does not configure an executable runtime. Set `runtime: 'sandbox'` in the workspace definition.")
}

export function createBasicWorkspaceSession(workspace: Workspace): WorkspaceSession {
  return {
    readFile: workspace.readFile,
    writeFile: workspace.writeFile,
    rm: workspace.rm,
    list: workspace.list,
    glob: workspace.glob,
    search: workspace.search,
    diff: () => workspace.diff(),
    async commit(options) {
      await workspace.snapshot({ name: options?.message || "session-commit" })
    },
    async exec(_command: string, _args: string[] = [], _options?: ExecOptions): Promise<ExecResult> {
      unsupportedExec()
    },
    async close() {},
  }
}
