import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

import { createLibsqlAgentInvocationStore } from "@vite-hub/agent/invocations/sqlite"
import { defineAgentInvocations } from "@vite-hub/agent/server"

import {
  installConsoleInvocationFallback,
  resolveConsoleInvocations,
  resolveConsoleInvocationsRoot,
} from "../../internal.ts"

import type { AgentInvocations } from "@vite-hub/agent"

export function getConsoleInvocations(): AgentInvocations {
  const invocations = resolveConsoleInvocations()
  if (!invocations) {
    throw new TypeError("[vitehub] The Agent invocation console has not been installed for this runtime.")
  }
  return invocations
}

export function createConsoleInvocations(projectRoot: string): AgentInvocations {
  const dataDirectory = resolve(projectRoot, ".vitehub/data")
  mkdirSync(dataDirectory, { recursive: true })
  return defineAgentInvocations({
    metadataContent: [
      "input.messages",
      "input.prompt",
      "message.content",
      "result.text",
      "tool.error",
      "tool.input",
      "tool.output",
      "vitehub.activity.progress",
    ],
    store: createLibsqlAgentInvocationStore({
      url: `file:${resolve(dataDirectory, "console.sqlite")}`,
    }),
  })
}

export function installConsoleInvocations(projectRoot: string): AgentInvocations {
  const resolvedRoot = resolve(projectRoot)
  const installed = resolveConsoleInvocations()
  if (installed && resolveConsoleInvocationsRoot() === resolvedRoot) return installed
  const invocations = createConsoleInvocations(resolvedRoot)
  installConsoleInvocationFallback(invocations, resolvedRoot)
  return invocations
}
