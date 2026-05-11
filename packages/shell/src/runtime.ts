import type { CommandName, IFileSystem } from "just-bash"

import { parseShellCommand } from "./parse.ts"

import type { ShellRuntime, ShellRuntimeExecOptions, ShellRuntimeExecResult } from "./types.ts"

const unsupportedShellSyntaxPattern = /(?:&&|\|\||[;|`<>\r\n]|\$\()/

function stderrResult(message: string, exitCode: number): ShellRuntimeExecResult {
  return {
    exitCode,
    stderr: `${message}\n`,
    stdout: "",
  }
}

function createPreflightExec(
  runtime: ShellRuntime,
  options: { allowedCommands?: string[], singleCommand?: boolean },
): ShellRuntime["exec"] {
  return async (command, execOptions) => {
    if (options.singleCommand !== false && unsupportedShellSyntaxPattern.test(command)) {
      return stderrResult("Unsupported shell syntax: only a single workspace command is supported.", 126)
    }

    let words: string[]
    try {
      words = parseShellCommand(command)
    }
    catch (error) {
      return stderrResult(error instanceof Error ? error.message : "Could not parse command.", 2)
    }

    if (!words.length) {
      return {
        exitCode: 0,
        stderr: "",
        stdout: "",
      }
    }

    const name = words[0]!
    if (options.allowedCommands?.length && !options.allowedCommands.includes(name)) {
      return stderrResult(`Unsupported workspace shell command: ${name}`, 126)
    }

    return await runtime.exec(command, execOptions)
  }
}

export function createJustBashRuntime(options: {
  commands?: string[]
  cwd?: string
  fs: IFileSystem & { writeFs: boolean }
}): ShellRuntime {
  return {
    supports: {
      cwd: true,
      env: true,
      streaming: false,
      writeFs: options.fs.writeFs,
    },
    async exec(command, execOptions: ShellRuntimeExecOptions = {}) {
      const { Bash } = await import("just-bash")
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

export function withShellRuntimePolicy(
  runtime: ShellRuntime,
  options: { allowedCommands?: string[], singleCommand?: boolean },
): ShellRuntime {
  return {
    exec: createPreflightExec(runtime, options),
    supports: runtime.supports,
  }
}
