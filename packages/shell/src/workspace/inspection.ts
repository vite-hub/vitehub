import { splitShellCommandSegments } from "../command/analyze.ts"
import { parseShellCommand } from "../command/parse.ts"
import { createJustBashProvider } from "../providers/just-bash.ts"
import { createShellRuntime } from "../runtime/index.ts"
import { workspaceMountPoint } from "./filesystem.ts"

import type { ShellObservation } from "../runtime/types.ts"
import type { WorkspaceShellFileSystem } from "./filesystem.ts"
import type { SearchableShellWorkspace } from "./types.ts"

interface WorkspaceInspectionCommandOptions {
  broadSearchPaths?: string[]
  commands?: string[]
  cwd?: string
  fs: WorkspaceShellFileSystem
  maxOutputLength?: number
  timeout?: number
}

export async function runWorkspaceInspectionCommand(
  _input: SearchableShellWorkspace,
  command: string,
  options: WorkspaceInspectionCommandOptions,
): Promise<ShellObservation> {
  const maxOutputLength = options.maxOutputLength || 30_000
  const timeout = options.timeout || 30_000
  const preflight = preflightWorkspaceInspectionCommand(command, options.broadSearchPaths)
  if (preflight) return preflight
  const runtime = createShellRuntime({
    policy: {
      maxOutputLength,
      timeout,
    },
    provider: createJustBashProvider({
      commands: options.commands,
      cwd: options.cwd || workspaceMountPoint,
      fs: options.fs,
    }),
  })
  return await runtime.exec(command, { cwd: options.cwd || workspaceMountPoint, timeout })
}

function preflightWorkspaceInspectionCommand(command: string, broadSearchPaths: string[] = []): ShellObservation | undefined {
  try {
    for (const segment of splitShellCommandSegments(command)) {
      const words = parseShellCommand(segment)
      if (isBroadWorkspaceSearch(words)) {
        const hint = broadSearchPaths.length
          ? ` Try one of these paths: ${broadSearchPaths.map(path => `"${path}"`).join(", ")}.`
          : " Use a narrow mounted source or subdirectory path instead."
        return {
          command,
          event: "policy_denied",
          exitCode: 126,
          stderr: `[vitehub] Workspace root search is too broad.${hint}\n`,
          stdout: "",
        }
      }
    }
  }
  catch {
    return undefined
  }
}

function isBroadWorkspaceSearch(words: string[]) {
  const name = words[0]
  if (name !== "rg") return false

  const paths = commandPathArguments(words)
  return paths.length === 0 || paths.some(path => path === "." || path === "./" || path === "/" || path === workspaceMountPoint)
}

function commandPathArguments(words: string[]) {
  const args = words.slice(1)
  const paths: string[] = []
  let sawPattern = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") {
      paths.push(...args.slice(index + 1))
      break
    }
    if (arg.startsWith("-")) {
      if (takesOptionValue(arg)) index += 1
      continue
    }
    if (!sawPattern) {
      sawPattern = true
      continue
    }
    paths.push(arg)
  }
  return paths
}

function takesOptionValue(arg: string) {
  return [
    "-A",
    "-B",
    "-C",
    "-e",
    "-f",
    "-g",
    "-m",
    "--after-context",
    "--before-context",
    "--context",
    "--glob",
    "--max-count",
    "--regexp",
  ].includes(arg)
}
