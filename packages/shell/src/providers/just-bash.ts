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
      enforcedBy: "provider",
      supported: true,
    },
  }

  return {
    analyze: analyzeShellCommand,
    boundary,
    async exec(command: string, execOptions: ShellRuntimeExecOptions = {}) {
      const result = await withProviderTimeout(command, execOptions, async () => {
        const { Bash } = await import("just-bash/browser")
        const bash = new Bash({
          commands: options.commands as CommandName[] | undefined,
          cwd: options.cwd,
          fs: options.fs,
        })
        const signal = typeof execOptions.timeout === "number"
          ? AbortSignal.timeout(execOptions.timeout)
          : undefined
        return await bash.exec(command, {
          cwd: execOptions.cwd,
          env: execOptions.env,
          signal,
        })
      })
      const timedOut = "timedOut" in result && result.timedOut === true
      execOptions.onStdout?.(result.stdout)
      execOptions.onStderr?.(result.stderr)
      return {
        command,
        cwd: execOptions.cwd,
        event: timedOut ? "command_timed_out" : "command_finished",
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut,
      }
    },
  }
}

async function withProviderTimeout<T extends { exitCode: number, stderr: string, stdout: string }>(
  command: string,
  options: ShellRuntimeExecOptions,
  run: () => Promise<T>,
): Promise<T | { exitCode: null, stderr: string, stdout: string, timedOut: true }> {
  if (typeof options.timeout !== "number") return await run()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<{ exitCode: null, stderr: string, stdout: string, timedOut: true }>((resolve) => {
        timeout = setTimeout(() => resolve({
          exitCode: null,
          stderr: `[vitehub] Workspace shell command timed out after ${options.timeout}ms.`,
          stdout: "",
          timedOut: true,
        }), options.timeout)
      }),
    ])
  }
  finally {
    if (timeout) clearTimeout(timeout)
  }
}
