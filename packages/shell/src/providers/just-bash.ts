import type { CommandName } from "just-bash/browser"
import type { IFileSystem } from "just-bash"

import { analyzeShellCommand } from "../command/analyze.ts"

import type {
  ShellBoundary,
  ShellExecutionProvider,
  ShellRuntimeExecOptions,
} from "../runtime/types.ts"

export interface JustBashFileSystem extends IFileSystem {
  readonly writeFs: boolean
}

export interface JustBashProviderOptions {
  commands?: string[]
  cwd?: string
  fs: JustBashFileSystem
}

export function createJustBashProvider(options: JustBashProviderOptions): ShellExecutionProvider {
  const boundary: ShellBoundary = {
    cwd: true,
    env: true,
    filesystem: {
      mountPoint: "/workspace",
      writable: options.fs.writeFs,
    },
    network: false,
    processes: {
      background: false,
      interactive: false,
    },
    streaming: false,
    timeout: {
      enforcedBy: "runtime",
      supported: true,
    },
  }

  return {
    analyze: analyzeShellCommand,
    boundary,
    async exec(command: string, execOptions: ShellRuntimeExecOptions = {}) {
      const { Bash } = await import("just-bash/browser")
      const bash = new Bash({
        commands: options.commands as CommandName[] | undefined,
        cwd: options.cwd,
        fs: options.fs,
      })
      const signal = typeof execOptions.timeout === "number"
        ? AbortSignal.timeout(execOptions.timeout)
        : undefined
      const result = await bash.exec(command, {
        cwd: execOptions.cwd,
        env: execOptions.env,
        signal,
      })
      execOptions.onStdout?.(result.stdout)
      execOptions.onStderr?.(result.stderr)
      return {
        command,
        cwd: execOptions.cwd,
        event: "command_finished",
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
      }
    },
  }
}
