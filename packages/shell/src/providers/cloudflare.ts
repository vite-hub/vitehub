import { analyzeShellCommand } from "../command/analyze.ts"
import { parseShellCommand } from "../command/parse.ts"

import type {
  ShellBoundary,
  ShellExecutionProvider,
  ShellRuntimeExecOptions,
} from "../runtime/types.ts"

export interface CloudflareShellClient {
  exec: (
    command: string,
    args?: string[],
    options?: {
      cwd?: string
      env?: Record<string, string>
      onStderr?: (data: string) => void
      onStdout?: (data: string) => void
      stdin?: string
      timeout?: number
    },
  ) => Promise<{
    code?: number | null
    exitCode?: number | null
    stderr: string
    stdout: string
  }>
  supports: {
    execCwd: boolean
    execEnv: boolean
  }
}

export interface CloudflareShellProviderOptions {
  sandbox: CloudflareShellClient
}

export function createCloudflareShellProvider(options: CloudflareShellProviderOptions): ShellExecutionProvider {
  const boundary: ShellBoundary = {
    cwd: options.sandbox.supports.execCwd,
    env: options.sandbox.supports.execEnv,
    filesystem: {
      writable: true,
    },
    network: "unknown",
    processes: {
      background: false,
      interactive: false,
    },
    streaming: true,
    timeout: {
      enforcedBy: "provider",
      supported: true,
    },
  }

  return {
    analyze: analyzeShellCommand,
    boundary,
    async exec(command: string, execOptions: ShellRuntimeExecOptions = {}) {
      const [cmd = "", ...args] = parseShellCommand(command)
      const result = await options.sandbox.exec(cmd, args, {
        cwd: execOptions.cwd,
        env: execOptions.env,
        onStderr: execOptions.onStderr,
        onStdout: execOptions.onStdout,
        stdin: execOptions.stdin,
        timeout: execOptions.timeout,
      })
      return {
        command,
        cwd: execOptions.cwd,
        event: "command_finished",
        exitCode: result.exitCode ?? result.code ?? null,
        stderr: result.stderr,
        stdout: result.stdout,
      }
    },
  }
}
