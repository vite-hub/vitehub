import type { CommandName } from "just-bash"

import { createCloudflareShellRuntime } from "./cloudflare.ts"
import { createJustBashRuntime, withShellRuntimePolicy } from "./runtime.ts"
import { cleanWorkspaceMutationPath, cleanWorkspaceShellPath, runWorkspaceInspectionCommand } from "./workspace-shell.ts"
import { createReadonlyWorkspaceFs, createWritableWorkspaceFs, workspaceMountPoint } from "./workspace-fs.ts"

import type { CreateShellRuntimeOptions, ShellRuntime } from "./types.ts"

export type * from "./types.ts"

export {
  createCloudflareShellRuntime,
  createReadonlyWorkspaceFs,
  createWritableWorkspaceFs,
  cleanWorkspaceMutationPath,
  cleanWorkspaceShellPath,
  runWorkspaceInspectionCommand,
  workspaceMountPoint,
}

export function createShellRuntime(options: CreateShellRuntimeOptions): ShellRuntime {
  const runtime = options.provider === "cloudflare-shell"
    ? createCloudflareShellRuntime({ sandbox: options.sandbox })
    : createJustBashRuntime({
        commands: options.commands as CommandName[] | undefined,
        cwd: options.cwd,
        fileSystem: options.fs,
        fs: options.fs,
      })

  return withShellRuntimePolicy(runtime, {
    allowedCommands: options.allowedCommands,
    singleCommand: options.singleCommand,
  })
}
