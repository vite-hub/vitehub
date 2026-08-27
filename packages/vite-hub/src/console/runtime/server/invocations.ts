import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

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

interface ConsoleDatabaseOptions {
  authToken?: string
  url: string
}

export function resolveConsoleDatabaseOptions(projectRoot: string): ConsoleDatabaseOptions {
  const configuredUrl = process.env.VITEHUB_CONSOLE_DATABASE_URL?.trim()
  const url = configuredUrl || `file:${resolve(projectRoot, ".vitehub/data/console.sqlite")}`
  const authToken = process.env.VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN
  if (!url.startsWith("file:")) return { ...(authToken ? { authToken } : {}), url }

  const filePath = url.startsWith("file://")
    ? fileURLToPath(url)
    : resolve(projectRoot, url.slice("file:".length))
  mkdirSync(dirname(filePath), { recursive: true })
  return { url: pathToFileURL(filePath).href }
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
    store: createLibsqlAgentInvocationStore(resolveConsoleDatabaseOptions(projectRoot)),
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
