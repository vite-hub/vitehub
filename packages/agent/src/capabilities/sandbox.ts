import { defineCapability } from "../capability-runtime.ts"
import {
  defineInternalTool,
  requirePrimitive,
} from "./internal.ts"

import type {
  AgentCapabilityDefinition,
  MaybePromise,
} from "../types.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"

export interface SandboxCapabilityOptions {
  commands: string[]
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
  return commands
}

export function sandbox(options: SandboxCapabilityOptions): AgentCapabilityDefinition {
  const commands = validateSandboxCommands(options?.commands)
  return defineCapability({
    id: "sandbox",
    metadata: { commands },
    requires: [{ primitive: "workspace", workspace: { required: true } }, { primitive: "sandbox" }],
    tools: (context) => {
      const handle = requirePrimitive(context as never, "sandbox") as {
        exec?: (command: string, args?: string[], options?: unknown) => MaybePromise<unknown>
      }
      return {
        sandbox_exec: defineInternalTool({
          description: `Run one allowed executable in an isolated sandbox. Allowed commands: ${commands.join(", ")}.`,
          name: "sandbox_exec",
          async execute(input) {
            const value = input as { args?: string[], command?: string, cwd?: string, env?: Record<string, string>, timeout?: number }
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Tool input must contain a string command before the allowed-command check.
            if (!value || typeof value.command !== "string") throw agentDiagnostics.AGENT_R0166({ message: "[vitehub] sandbox_exec requires a command." })
            if (!commands.includes(value.command)) throw agentDiagnostics.AGENT_R0167({ message: `[vitehub] Sandbox command "${value.command}" is not allowed.` })
            if (!handle.exec) throw agentDiagnostics.AGENT_R0168({ message: "[vitehub] Sandbox primitive does not expose exec()." })
            return await handle.exec(value.command, value.args || [], { cwd: value.cwd, env: value.env, timeout: value.timeout })
          },
        }),
      }
    },
  })
}
