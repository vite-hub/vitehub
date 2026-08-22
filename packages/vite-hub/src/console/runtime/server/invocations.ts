import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

import { createLibsqlAgentInvocationStore } from "@vite-hub/agent/invocations/sqlite"
import { defineAgentInvocations } from "@vite-hub/agent/server"

import { consoleInvocationsKey } from "../../internal.ts"

import type { AgentInvocations } from "@vite-hub/agent"

type ConsoleGlobal = typeof globalThis & Record<symbol, AgentInvocations | undefined>

export function getConsoleInvocations(): AgentInvocations {
  const scope = globalThis as ConsoleGlobal
  if (!scope[consoleInvocationsKey]) {
    const dataDirectory = resolve(process.cwd(), ".vitehub/data")
    mkdirSync(dataDirectory, { recursive: true })
    scope[consoleInvocationsKey] = defineAgentInvocations({
      store: createLibsqlAgentInvocationStore({
        url: `file:${resolve(dataDirectory, "console.sqlite")}`,
      }),
    })
  }
  return scope[consoleInvocationsKey]
}
