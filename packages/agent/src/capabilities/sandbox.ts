import { defineCapability } from "../capability-runtime.ts"
import {
  defineInternalTool,
  requirePrimitive,
} from "./internal.ts"

import type {
  AgentCapabilityDefinition,
  MaybePromise,
} from "../types.ts"
import type { HarnessV1SandboxProvider } from "@ai-sdk/harness"

export type SandboxCapabilityOptions =
  | { commands: string[], provider?: HarnessV1SandboxProvider }
  | { commands?: string[], provider: HarnessV1SandboxProvider }

function validateSandboxCommands(commands: unknown): string[] | undefined {
  if (commands === undefined) return undefined
  if (!Array.isArray(commands) || !commands.length) {
    throw new TypeError("[vitehub] sandbox({ commands }) requires at least one executable name.")
  }
  for (const command of commands) {
    if (typeof command !== "string" || !/^[A-Za-z0-9_.-]+$/.test(command)) {
      throw new TypeError("[vitehub] sandbox({ commands }) accepts executable names only, not shell command strings.")
    }
  }
  return commands
}

function validateSandboxProvider(provider: unknown): HarnessV1SandboxProvider | undefined {
  if (provider === undefined) return undefined
  if (!provider || typeof provider !== "object") {
    throw new TypeError("[vitehub] sandbox({ provider }) requires a harness sandbox provider.")
  }
  return provider as HarnessV1SandboxProvider
}

export function sandbox(options: SandboxCapabilityOptions): AgentCapabilityDefinition {
  const commands = validateSandboxCommands(options?.commands)
  const provider = validateSandboxProvider(options?.provider)
  if (!commands && !provider) {
    throw new TypeError("[vitehub] sandbox() requires commands or provider.")
  }
  return defineCapability({
    id: "sandbox",
    ...(provider ? { harnessSandboxProvider: provider } : {}),
    metadata: { ...(commands ? { commands } : {}), ...(provider ? { provider: true } : {}) },
    ...(commands
      ? {
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
                  if (!value || typeof value.command !== "string") throw new TypeError("[vitehub] sandbox_exec requires a command.")
                  if (!commands.includes(value.command)) throw new Error(`[vitehub] Sandbox command "${value.command}" is not allowed.`)
                  if (!handle.exec) throw new Error("[vitehub] Sandbox primitive does not expose exec().")
                  return await handle.exec(value.command, value.args || [], { cwd: value.cwd, env: value.env, timeout: value.timeout })
                },
              }),
            }
          },
        }
      : {}),
  })
}
