import { parseShellCommand } from "./runtime.ts"

import type { ShellRuntime } from "./types.ts"
import type { CloudflareShellRuntimeOptions, ShellRuntimeExecOptions } from "./types.ts"

export function createCloudflareShellRuntime(options: CloudflareShellRuntimeOptions): ShellRuntime {
  return {
    supports: {
      cwd: options.sandbox.supports.execCwd,
      env: options.sandbox.supports.execEnv,
      streaming: true,
      writeFs: true,
    },
    async exec(command, execOptions: ShellRuntimeExecOptions = {}) {
      const [cmd = "", ...args] = parseShellCommand(command)
      const result = await options.sandbox.exec(cmd, args, {
        cwd: execOptions.cwd,
        env: execOptions.env,
        onStderr: execOptions.onStderr,
        onStdout: execOptions.onStdout,
        timeout: execOptions.timeout,
      })
      return {
        exitCode: result.code,
        stderr: result.stderr,
        stdout: result.stdout,
      }
    },
  }
}
