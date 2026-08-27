import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"

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

function consoleDatabaseUrl(projectRoot: string): string {
  const configuredUrl = process.env.VITEHUB_CONSOLE_DATABASE_URL?.trim()
  const url = configuredUrl || `file:${resolve(projectRoot, ".vitehub/data/console.sqlite")}`
  if (!url.startsWith("file:")) return url

  const filePath = resolve(projectRoot, url.slice("file:".length))
  mkdirSync(dirname(filePath), { recursive: true })
  return `file:${filePath}`
}

export function createConsoleInvocations(projectRoot: string): AgentInvocations {
  return defineAgentInvocations({
    metadataContent: [
      "input.messages",
      "input.prompt",
      "message.content",
      "result.text",
      "vitehub.activity.progress",
    ],
    store: createLibsqlAgentInvocationStore({
      url: consoleDatabaseUrl(projectRoot),
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
