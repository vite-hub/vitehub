import { defineInternalTool } from "./internal.ts"

import type {
  AgentCapabilityMode,
  AgentToolSet,
} from "../types.ts"
import type { WorkspaceSession } from "@vite-hub/workspace"

interface WorkspaceCommandInput {
  args?: string[]
  command: string
  cwd?: string
  env?: Record<string, string>
  timeout?: number
}

type WorkspaceCommandWorkspace = {
  startSession: () => Promise<WorkspaceSession>
}

export interface WorkspaceCommandEntry {
  command: string
  description?: string
  install?: string
}

interface WorkspaceCommandToolOptions {
  commitMessage?: string
  description?: string
  missingWorkspaceMessage?: string
  toolName?: string
}

interface BoxCommandOptions {
  abortSignal?: AbortSignal
  check?: boolean
  commitMessage?: string
  cwd?: string
  env?: Record<string, string>
  timeout?: number
}

const unsafeCommand = /[\s\x00-\x1F\x7F]/
const blockedEnvKeys = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
])
const defaultWorkspaceCommandTimeout = 60_000

export function normalizeWorkspaceCommandEntries(commands: unknown, label = "workspaceShell({ commands })"): WorkspaceCommandEntry[] {
  if (!Array.isArray(commands) || !commands.length) {
    throw new TypeError(`[vitehub] ${label} requires at least one command.`)
  }
  return commands.map((entry) => {
    if (typeof entry === "string") {
      if (!isValidCommand(entry)) {
        throw new TypeError(`[vitehub] ${label} accepts simple executable names or absolute paths without whitespace/control characters.`)
      }
      return { command: entry }
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`[vitehub] ${label} accepts simple executable names or absolute paths without whitespace/control characters.`)
    }
    const command = (entry as WorkspaceCommandEntry).command
    if (!isValidCommand(command)) {
      throw new TypeError(`[vitehub] ${label} accepts simple executable names or absolute paths without whitespace/control characters.`)
    }
    const description = (entry as WorkspaceCommandEntry).description
    const install = (entry as WorkspaceCommandEntry).install
    if (description !== undefined && typeof description !== "string") {
      throw new TypeError(`[vitehub] ${label} description must be a string.`)
    }
    if (install !== undefined && typeof install !== "string") {
      throw new TypeError(`[vitehub] ${label} install must be a string.`)
    }
    return { command, ...(description ? { description } : {}), ...(install ? { install } : {}) }
  })
}

export function validateWorkspaceCommands(commands: unknown, label = "workspaceShell({ commands })"): string[] {
  return normalizeWorkspaceCommandEntries(commands, label).map(entry => entry.command)
}

function isValidCommand(command: string): boolean {
  if (!command || unsafeCommand.test(command)) return false
  if (command.startsWith("/")) return command.length > 1 && !command.endsWith("/")
  return command !== "." && command !== ".." && !command.includes("/")
}

export function normalizeWorkspaceCommandTimeout(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`[vitehub] ${label} must be a positive number.`)
  }
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new TypeError(`[vitehub] workspace_exec ${label} must be an array of strings.`)
  }
  return value
}

function envRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("[vitehub] workspace_exec env must be an object with string values.")
  }
  const env = value as Record<string, unknown>
  for (const [key, item] of Object.entries(env)) {
    if (!key || key.includes("=") || key.includes("\0")) {
      throw new TypeError("[vitehub] workspace_exec env keys must be valid environment variable names.")
    }
    const normalizedKey = key.toUpperCase()
    if (blockedEnvKeys.has(normalizedKey) || normalizedKey.startsWith("LD_") || normalizedKey.startsWith("DYLD_")) {
      throw new TypeError("[vitehub] workspace_exec env cannot override PATH or loader-related variables.")
    }
    if (typeof item !== "string") {
      throw new TypeError("[vitehub] workspace_exec env must be an object with string values.")
    }
  }
  return env as Record<string, string>
}

function normalizeCwd(cwd: unknown): string {
  if (cwd !== undefined && typeof cwd !== "string") {
    throw new TypeError("[vitehub] workspace_exec cwd must be a string.")
  }
  const stripped = (cwd || "").replace(/\\/g, "/").replace(/^\/workspace(?:\/|$)/, "")
  const parts = stripped.split("/").filter(Boolean)
  if (parts.some(part => part === "." || part === "..")) {
    throw new Error("[vitehub] workspace_exec cwd must stay inside the workspace.")
  }
  return parts.length ? `/workspace/${parts.join("/")}` : "/workspace"
}

function assertWorkspace(workspace: unknown, message: string): asserts workspace is WorkspaceCommandWorkspace {
  if (!workspace || typeof workspace !== "object" || typeof (workspace as { startSession?: unknown }).startSession !== "function") {
    throw new Error(message)
  }
}

export async function executeWorkspaceCommand(
  workspace: unknown,
  command: string,
  args: string[] = [],
  options: BoxCommandOptions = {},
): Promise<Awaited<ReturnType<WorkspaceSession["exec"]>>> {
  assertWorkspace(workspace, "[vitehub] Capability command execution requires an execution-capable Workspace Session.")
  const session = await workspace.startSession()
  let result
  try {
    result = await session.exec(command, args, {
      abortSignal: options.abortSignal,
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
    })
    if (options.check && result.exitCode !== 0) {
      throw Object.assign(new Error(`[vitehub] Workspace command "${command}" exited with code ${result.exitCode}.`), {
        command,
        exitCode: result.exitCode,
        name: "BoxCommandError",
        stderr: result.stderr,
        stdout: result.stdout,
      })
    }
    if (options.commitMessage !== undefined && result.exitCode === 0) {
      await session.commit({ message: options.commitMessage })
    }
  }
  catch (error) {
    try {
      await session.close()
    }
    catch (closeError) {
      throw new AggregateError([error, closeError], "[vitehub] Workspace command failed and session cleanup also failed.")
    }
    throw error
  }
  await session.close()
  return result
}

export function workspaceCommandTools(
  commands: readonly (string | WorkspaceCommandEntry)[] | "all",
  mode: AgentCapabilityMode,
  timeout: number | undefined,
  workspace: unknown,
  options: WorkspaceCommandToolOptions = {},
): AgentToolSet {
  const unrestricted = commands === "all"
  const entries = unrestricted ? [] : commands.map(command => typeof command === "string" ? { command } : command)
  const commandNames = entries.map(entry => entry.command)
  const toolName = options.toolName || "workspace_exec"
  const summary = entries.map(entry => entry.description ? `${entry.command} (${entry.description})` : entry.command).join(", ")
  return {
    [toolName]: defineInternalTool({
      description: options.description || (unrestricted
        ? "Run any executable in the Workspace Session."
        : `Run one configured command in the Workspace Session at the workspace root. Allowed commands: ${summary}.`),
      inputSchema: {
        additionalProperties: false,
        properties: {
          args: { items: { type: "string" }, type: "array" },
          command: unrestricted
            ? { description: "Executable name or absolute executable path.", type: "string" }
            : { enum: commandNames, type: "string" },
          cwd: { description: "Workspace-relative directory. Defaults to the workspace root.", type: "string" },
          env: { additionalProperties: { type: "string" }, type: "object" },
          timeout: { type: "number" },
        },
        required: ["command"],
        type: "object",
      },
      name: toolName,
      async execute(input: unknown) {
        const value = input as WorkspaceCommandInput
        if (!value || typeof value.command !== "string") throw new TypeError(`[vitehub] ${toolName} requires a command.`)
        if (unrestricted) normalizeWorkspaceCommandEntries([value.command], `${toolName} command`)
        else if (!commandNames.includes(value.command)) throw new Error(`[vitehub] Workspace command "${value.command}" is not allowed.`)
        const args = stringArray(value.args, "args")
        const cwd = normalizeCwd(value.cwd)
        const env = envRecord(value.env)
        const commandTimeout = normalizeWorkspaceCommandTimeout(value.timeout, `${toolName} timeout`) ?? timeout ?? defaultWorkspaceCommandTimeout
        assertWorkspace(workspace, options.missingWorkspaceMessage || "[vitehub] workspaceShell({ commands }) requires an execution-capable writable Workspace Session.")
        return await executeWorkspaceCommand(workspace, value.command, args, {
          ...(mode === "write" ? { commitMessage: options.commitMessage || "workspace shell command" } : {}),
          cwd,
          env,
          timeout: commandTimeout,
        })
      },
    }),
  }
}
