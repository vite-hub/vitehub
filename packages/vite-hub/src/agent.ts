import { defineAgent as defineUpstreamAgent } from "@vite-hub/agent"

import { agentInvocationsDisabledKey, resolveAgentInvocationsSetting, resolveDefaultAgentInvocations } from "./_internal/agent/invocations.ts"
import { consoleInvocationsFallbackKey, resolveConsoleInvocations } from "./console/internal.ts"

export * from "@vite-hub/agent"
export type { AgentInvocationsSetting, AgentInvocationsStoreName, AgentInvocationsStoreOptions } from "./_internal/agent/invocations.ts"

import type { AgentInvocations, DefineAgent } from "@vite-hub/agent"
import type { AgentInvocationsSetting } from "./_internal/agent/invocations.ts"

declare module "@vite-hub/agent" {
  interface AgentInvocationsHostSettings {
    vitehub: AgentInvocationsSetting
  }
}

function inheritsDisabledInvocations(parent: unknown): boolean {
  return Object(parent) === parent && Reflect.get(Object(parent), agentInvocationsDisabledKey) === true
}

export const defineAgent: DefineAgent = ((options: Parameters<DefineAgent>[0]) => {
  const setting: AgentInvocationsSetting | undefined = options.invocations
  const disabled = setting === false || (setting === undefined && "extends" in options && inheritsDisabledInvocations(options.extends))
  const invocations = resolveAgentInvocationsSetting(setting)
  let agentOptions = options
  if (setting !== invocations) {
    const { invocations: _setting, ...rest } = options
    agentOptions = invocations ? { ...rest, invocations } : rest
  }
  const agent = defineUpstreamAgent(agentOptions as never)
  if (!disabled && agent.invocations !== undefined) return agent

  // Without an explicit journal, the app-wide `agent.invocations` journal applies, then the Console journal.
  let assignedInvocations: AgentInvocations | undefined
  if (disabled) Object.defineProperty(agent, agentInvocationsDisabledKey, { configurable: true, enumerable: false, value: true })
  Object.defineProperty(agent, consoleInvocationsFallbackKey, {
    configurable: true,
    enumerable: false,
    get() {
      return assignedInvocations === undefined
    },
  })
  Object.defineProperty(agent, "invocations", {
    configurable: true,
    enumerable: false,
    get() {
      if (assignedInvocations || disabled) return assignedInvocations
      return resolveDefaultAgentInvocations() ?? resolveConsoleInvocations()
    },
    set(value: AgentInvocations | undefined) {
      assignedInvocations = value
    },
  })
  return agent
}) as DefineAgent
