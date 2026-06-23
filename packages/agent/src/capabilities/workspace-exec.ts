import {
  defineCapability,
  normalizeMode,
} from "../capability-runtime.ts"
import { defineInternalTool } from "./internal.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentToolSet,
} from "../types.ts"
import type { WorkspaceSession } from "@vite-hub/workspace"

export interface WorkspaceExecOptions {
  commands: string[]
  mode?: AgentCapabilityMode
  timeout?: number
}

interface WorkspaceExecInput {
  args?: string[]
  command: string
  cwd?: string
  env?: Record<string, string>
  timeout?: number
}

type WorkspaceExecWorkspace = {
  startSession: () => Promise<WorkspaceSession>
}

const unsafeCommand = /[\s\x00-\x1F\x7F]/
const blockedEnvKeys = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
])

function validateCommands(commands: unknown): string[] {
  if (!Array.isArray(commands) || !commands.length) {
    throw new TypeError("[vitehub] workspaceExec({ commands }) requires at least one command.")
  }
  for (const command of commands) {
    if (typeof command !== "string" || !isValidCommand(command)) {
      throw new TypeError("[vitehub] workspaceExec({ commands }) accepts simple executable names or absolute paths without whitespace/control characters.")
    }
  }
  return commands
}

function isValidCommand(command: string): boolean {
  if (!command || unsafeCommand.test(command)) return false
  if (command.startsWith("/")) return command.length > 1 && !command.endsWith("/")
  return command !== "." && command !== ".." && !command.includes("/")
}

function normalizeTimeout(value: unknown, label: string): number | undefined {
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

function assertWorkspace(workspace: unknown): asserts workspace is WorkspaceExecWorkspace {
  if (!workspace || typeof workspace !== "object" || typeof (workspace as { startSession?: unknown }).startSession !== "function") {
    throw new Error("[vitehub] workspaceExec() requires an executable Workspace Session. Configure the agent with a writable workspace for trusted workspace/session execution.")
  }
}

function workspaceExecTools(
  commands: string[],
  mode: AgentCapabilityMode,
  timeout: number | undefined,
  workspace: unknown,
): AgentToolSet {
  return {
    workspace_exec: defineInternalTool({
      description: `Run one configured command in a trusted Workspace Session at the workspace root. Allowed commands: ${commands.join(", ")}.`,
      inputSchema: {
        additionalProperties: false,
        properties: {
          args: { items: { type: "string" }, type: "array" },
          command: { enum: commands, type: "string" },
          cwd: { description: "Workspace-relative directory. Defaults to the workspace root.", type: "string" },
          env: { additionalProperties: { type: "string" }, type: "object" },
          timeout: { type: "number" },
        },
        required: ["command"],
        type: "object",
      },
      name: "workspace_exec",
      async execute(input: unknown) {
        const value = input as WorkspaceExecInput
        if (!value || typeof value.command !== "string") throw new TypeError("[vitehub] workspace_exec requires a command.")
        if (!commands.includes(value.command)) throw new Error(`[vitehub] Workspace command "${value.command}" is not allowed.`)
        const args = stringArray(value.args, "args")
        const cwd = normalizeCwd(value.cwd)
        const env = envRecord(value.env)
        const commandTimeout = normalizeTimeout(value.timeout, "workspace_exec timeout") ?? timeout
        assertWorkspace(workspace)
        const session = await workspace.startSession()
        try {
          const result = await session.exec(value.command, args, { cwd, env, timeout: commandTimeout })
          if (mode === "write" && result.exitCode === 0) await session.commit({ message: "workspace exec" })
          return result
        }
        finally {
          await session.close()
        }
      },
    }),
  }
}

export function workspaceExec(options: WorkspaceExecOptions): AgentCapabilityDefinition {
  const commands = validateCommands(options?.commands)
  const mode = normalizeMode(options?.mode, "Workspace Exec")
  const timeout = normalizeTimeout(options?.timeout, "workspaceExec({ timeout })")
  return defineCapability({
    id: "workspace-exec",
    instructions: [
      `workspace_exec runs only configured commands in a trusted Workspace Session at the workspace root: ${commands.join(", ")}.`,
      mode === "write"
        ? "Successful commands are committed back to the Workspace Store. This is trusted workspace/session execution, not the read-only Workspace Shell."
        : "Read mode requires a writable Workspace Session for trusted execution, but does not commit command changes. This is not the read-only Workspace Shell.",
    ],
    metadata: { commands, mode, ...(timeout ? { timeout } : {}) },
    mode,
    requires: [{ primitive: "workspace", workspace: { mode: "write", required: true } }],
    tools: context => workspaceExecTools(commands, mode, timeout, context.workspace),
  })
}
