import { createCloudflareShellRuntime } from "./cloudflare.ts"
import { analyzeShellCommand } from "./analyze.ts"
import { createJustBashRuntime } from "./runtime.ts"
import { cleanWorkspaceMutationPath, cleanWorkspaceShellPath, runWorkspaceInspectionCommand } from "./workspace-shell.ts"
import { createReadonlyWorkspaceFs, createWritableWorkspaceFs, workspaceMountPoint } from "./workspace-fs.ts"
import { parseShellCommand } from "./parse.ts"

import type { CreateShellRuntimeOptions, ShellRuntime } from "./types.ts"

export type * from "./types.ts"

export {
  analyzeShellCommand,
  createCloudflareShellRuntime,
  createReadonlyWorkspaceFs,
  createWritableWorkspaceFs,
  cleanWorkspaceMutationPath,
  cleanWorkspaceShellPath,
  parseShellCommand,
  runWorkspaceInspectionCommand,
  workspaceMountPoint,
}

export function createShellRuntime(options: CreateShellRuntimeOptions): ShellRuntime {
  return options.provider === "cloudflare-shell"
    ? createCloudflareShellRuntime({ sandbox: options.sandbox })
    : createJustBashRuntime({
        commands: options.commands,
        cwd: options.cwd,
        fs: options.fs,
      })
}
