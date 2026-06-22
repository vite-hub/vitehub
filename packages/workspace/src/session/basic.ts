import { WorkspaceError } from "../core/errors.ts"

import type { ExecOptions, ExecResult, Workspace, WorkspaceSession } from "../core/types.ts"

function unsupportedExec(): never {
  throw new WorkspaceError("[vitehub] Workspace exec requires an executable runtime. Set `runtime: 'sandbox'` for hosted or untrusted execution, set `runtime: 'trusted-host'` for trusted local development and tests, or avoid session.exec().")
}

export function createBasicWorkspaceSession(workspace: Workspace): WorkspaceSession {
  return {
    readFile: workspace.readFile,
    writeFile: workspace.writeFile,
    mkdir: workspace.mkdir,
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
