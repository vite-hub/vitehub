import { defineAgent as defineUpstreamAgent } from "@vite-hub/agent"

import { consoleInvocationsKey } from "./console/internal.ts"

export * from "@vite-hub/agent"

import type { AgentInvocations, DefineAgent } from "@vite-hub/agent"

export const defineAgent: DefineAgent = ((options: Parameters<DefineAgent>[0]) => {
  const agent = defineUpstreamAgent(options as never)
  if (agent.invocations !== undefined) return agent

  let assignedInvocations: AgentInvocations | undefined
  Object.defineProperty(agent, "invocations", {
    configurable: true,
    enumerable: true,
    get() {
      return assignedInvocations ?? globalConsoleInvocations()
    },
    set(value: AgentInvocations | undefined) {
      assignedInvocations = value
    },
  })
  return agent
}) as DefineAgent

function globalConsoleInvocations(): AgentInvocations | undefined {
  return (globalThis as typeof globalThis & Record<symbol, AgentInvocations | undefined>)[consoleInvocationsKey]
}
