import type { CommandName, IFileSystem } from "just-bash/browser"

import { analyzeShellCommand } from "./analyze.ts"

import type { ShellRuntime, ShellRuntimeExecOptions } from "./types.ts"

export function createJustBashRuntime(options: {
  commands?: string[]
  cwd?: string
  fs: IFileSystem & { writeFs: boolean }
}): ShellRuntime {
  return {
    analyze: analyzeShellCommand,
    supports: {
      cwd: true,
      env: true,
      streaming: false,
      writeFs: options.fs.writeFs,
    },
    async exec(command, execOptions: ShellRuntimeExecOptions = {}) {
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
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
      }
    },
  }
}
