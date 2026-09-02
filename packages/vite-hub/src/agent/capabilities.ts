export * from "@vite-hub/agent/capabilities"

import { inputCommands as baseInputCommands } from "@vite-hub/agent/capabilities"

import type { AgentCapabilityDefinition } from "@vite-hub/agent"
import type {
  InputCommand,
  InputCommandResult,
  InputCommandRunInput,
  InputCommandsOptions,
} from "@vite-hub/agent/capabilities"
import type { ConsoleRuntime } from "../console/server.ts"

export type ConsoleInputCommand = Omit<InputCommand, "call"> & {
  call?: (input: Omit<InputCommandRunInput, "command" | "context"> & {
    command: ConsoleInputCommand
    context: InputCommandRunInput["context"] & { console: ConsoleRuntime }
  }) => InputCommandResult | Promise<InputCommandResult>
}

export interface ConsoleInputCommandsOptions extends Omit<InputCommandsOptions, "commands"> {
  commands: Record<string, ConsoleInputCommand>
}

export function inputCommands(options: ConsoleInputCommandsOptions): AgentCapabilityDefinition {
  // SAFETY: The full-distribution wrapper supplies the Console Runtime Capability promised to these command callbacks.
  return baseInputCommands(options as InputCommandsOptions)
}
