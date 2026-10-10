import { defineAgent as defineUpstreamAgent } from "@vite-hub/agent"
import { defineAgentInvocations } from "@vite-hub/agent/server"
import { databases } from "@vite-hub/database/drizzle"

import { createDatabaseAgentInvocationStore } from "./agent/invocations/database.ts"

import { consoleInvocationsFallbackKey, resolveConsoleInvocations } from "./console/internal.ts"

export * from "@vite-hub/agent"

import type { AgentInvocations, DefineAgent } from "@vite-hub/agent"

let databaseInvocations: AgentInvocations | undefined

function defaultDatabaseInvocations(): AgentInvocations | undefined {
  if (!Object.keys(databases.default?.schema ?? {}).length) return
  return databaseInvocations ??= defineAgentInvocations({ store: createDatabaseAgentInvocationStore() })
}

export const defineAgent: DefineAgent = ((options: Parameters<DefineAgent>[0]) => {
  const agent = defineUpstreamAgent(options as never)
  if (agent.invocations === undefined) {
    const invocations = defaultDatabaseInvocations()
    if (invocations) agent.invocations = invocations
  }
  if (agent.invocations !== undefined) return agent

  let assignedInvocations: AgentInvocations | undefined
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
      return assignedInvocations ?? resolveConsoleInvocations()
    },
    set(value: AgentInvocations | undefined) {
      assignedInvocations = value
    },
  })
  return agent
}) as DefineAgent
