import { defineCapability } from "../capability-runtime.ts"
import {
  defineInternalTool,
  requirePrimitive,
} from "./internal.ts"

import type {
  AgentCapabilityDefinition,
  AgentToolExecutionContext,
  AgentToolSchema,
  MaybePromise,
} from "../types.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"

export interface SandboxCapabilityOptions {
  commands: string[]
}

const maxSandboxArgs = 128
const maxSandboxArgLength = 32_768
const maxSandboxEnvironmentEntries = 64
const maxSandboxEnvironmentValueLength = 32_768
const maxSandboxTimeout = 2_147_483_647
const blockedSandboxEnvironmentKeys = new Set(["NODE_OPTIONS", "NODE_PATH", "PATH"])

interface SandboxExecOptions {
  cwd?: string
  env?: Record<string, string>
  signal?: AbortSignal
  timeout?: number
}

interface SandboxExecInput {
  args?: string[]
  command?: string
  cwd?: string
  env?: Record<string, string>
  timeout?: number
}

function validateSandboxCommands(commands: unknown): string[] {
  if (!Array.isArray(commands) || !commands.length) {
    throw agentDiagnostics.AGENT_R0164({ message: "[vitehub] sandbox({ commands }) requires at least one executable name." })
  }
  for (const command of commands) {
    if (typeof command !== "string" || !/^[A-Za-z0-9_.-]+$/.test(command)) {
      throw agentDiagnostics.AGENT_R0165({ message: "[vitehub] sandbox({ commands }) accepts executable names only, not shell command strings." })
    }
  }
  return [...commands]
}

function validateSandboxArgs(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maxSandboxArgs || value.some(argument => typeof argument !== "string" || argument.length > maxSandboxArgLength)) {
    throw agentDiagnostics.AGENT_R0204({ message: `[vitehub] sandbox_exec args must be an array of no more than ${maxSandboxArgs} strings, each no longer than ${maxSandboxArgLength} characters.` })
  }
  return value
}

function validateSandboxCwd(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    throw agentDiagnostics.AGENT_R0205({ message: "[vitehub] sandbox_exec cwd must be a string." })
  }
  return value
}

function validateSandboxEnvironment(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentDiagnostics.AGENT_R0206({ message: "[vitehub] sandbox_exec env must be an object with string values." })
  }
  const environment = value as Record<string, unknown>
  const entries = Object.entries(environment)
  if (entries.length > maxSandboxEnvironmentEntries) {
    throw agentDiagnostics.AGENT_R0207({ message: `[vitehub] sandbox_exec env must contain no more than ${maxSandboxEnvironmentEntries} entries.` })
  }
  for (const [name, item] of entries) {
    const normalizedName = name.toUpperCase()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || blockedSandboxEnvironmentKeys.has(normalizedName) || normalizedName.startsWith("LD_") || normalizedName.startsWith("DYLD_")) {
      throw agentDiagnostics.AGENT_R0208({ message: "[vitehub] sandbox_exec env cannot override PATH, NODE_OPTIONS, NODE_PATH, or loader-related variables." })
    }
    if (typeof item !== "string" || item.length > maxSandboxEnvironmentValueLength) {
      throw agentDiagnostics.AGENT_R0209({ message: `[vitehub] sandbox_exec env values must be strings no longer than ${maxSandboxEnvironmentValueLength} characters.` })
    }
  }
  return environment as Record<string, string>
}

function validateSandboxTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maxSandboxTimeout) {
    throw agentDiagnostics.AGENT_R0210({ message: `[vitehub] sandbox_exec timeout must be a positive number no greater than ${maxSandboxTimeout}.` })
  }
  return value
}

function sandboxExecInputSchema(commands: readonly string[]): AgentToolSchema {
  return {
    additionalProperties: false,
    properties: {
      args: { items: { maxLength: maxSandboxArgLength, type: "string" }, maxItems: maxSandboxArgs, type: "array" },
      command: { enum: [...commands], type: "string" },
      cwd: { type: "string" },
      env: {
        additionalProperties: { maxLength: maxSandboxEnvironmentValueLength, type: "string" },
        maxProperties: maxSandboxEnvironmentEntries,
        propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        type: "object",
      },
      timeout: { maximum: maxSandboxTimeout, exclusiveMinimum: 0, type: "number" },
    },
    required: ["command"],
    type: "object",
  }
}

export function sandbox(options: SandboxCapabilityOptions): AgentCapabilityDefinition {
  const commands = Object.freeze(validateSandboxCommands(options?.commands))
  const metadataCommands = Object.freeze([...commands])
  return defineCapability({
    id: "sandbox",
    metadata: { commands: metadataCommands },
    requires: [{ primitive: "workspace", workspace: { required: true } }, { primitive: "sandbox" }],
    tools: (context) => {
      const handle = requirePrimitive(context as never, "sandbox") as {
        exec?: (command: string, args?: string[], options?: unknown) => MaybePromise<unknown>
      }
      return {
        sandbox_exec: defineInternalTool({
          description: `Run one allowed executable in an isolated sandbox. Allowed commands: ${commands.join(", ")}.`,
          inputSchema: sandboxExecInputSchema(commands),
          name: "sandbox_exec",
          async execute(input, execution: AgentToolExecutionContext = {}) {
            const value = input as SandboxExecInput
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Tool input must contain a string command before the allowed-command check.
            if (!value || typeof value.command !== "string") throw agentDiagnostics.AGENT_R0166({ message: "[vitehub] sandbox_exec requires a command." })
            if (!commands.includes(value.command)) throw agentDiagnostics.AGENT_R0167({ message: `[vitehub] Sandbox command "${value.command}" is not allowed.` })
            if (!handle.exec) throw agentDiagnostics.AGENT_R0168({ message: "[vitehub] Sandbox primitive does not expose exec()." })
            const args = validateSandboxArgs(value.args)
            const cwd = validateSandboxCwd(value.cwd)
            const env = validateSandboxEnvironment(value.env)
            const timeout = validateSandboxTimeout(value.timeout)
            const execOptions: SandboxExecOptions = {
              ...(cwd === undefined ? {} : { cwd }),
              ...(env === undefined ? {} : { env }),
              ...(execution.abortSignal === undefined ? {} : { signal: execution.abortSignal }),
              ...(timeout === undefined ? {} : { timeout }),
            }
            return await handle.exec(value.command, args, execOptions)
          },
        }),
      }
    },
  })
}
