import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createLibsqlAgentInvocationStore } from "@vite-hub/agent/invocations/sqlite"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"

import {
  createConsoleInvocationsIdentity,
  installConsoleInvocationFallback,
  resolveConsoleInvocations,
  resolveConsoleInvocationsIdentity,
  resolveConsoleInvocationsRevision,
} from "../../internal.ts"
import { consoleFixtureRevision, readConsoleFixture } from "../../fixture.ts"

import type { AgentInvocations } from "@vite-hub/agent"
import type { ConsoleFixture } from "../../fixture.ts"

const consoleMetadataContent = [
  "input.messages",
  "input.prompt",
  "message.content",
  "result.text",
  "tool.input",
  "tool.output",
  "vitehub.activity.progress",
] as const

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
  if (!/^file:/i.test(url)) {
    const options: ConsoleDatabaseOptions = { url }
    if (authToken) options.authToken = authToken
    return options
  }

  const fragmentIndex = url.indexOf("#")
  const urlWithoutFragment = fragmentIndex === -1 ? url : url.slice(0, fragmentIndex)
  const queryIndex = urlWithoutFragment.indexOf("?")
  const fileUrl = queryIndex === -1 ? urlWithoutFragment : urlWithoutFragment.slice(0, queryIndex)
  const query = queryIndex === -1 ? "" : urlWithoutFragment.slice(queryIndex)
  const isAbsoluteFileUrl = /^file:\//i.test(fileUrl)
  const relativeFilePath = isAbsoluteFileUrl
    ? undefined
    : decodeURIComponent(fileUrl.slice("file:".length))
  if (relativeFilePath === ":memory:") return { url: urlWithoutFragment }
  const filePath = isAbsoluteFileUrl
    ? fileURLToPath(fileUrl)
    : resolve(projectRoot, relativeFilePath!)
  mkdirSync(dirname(filePath), { recursive: true })
  return { url: `${pathToFileURL(filePath).href}${query}` }
}

export function createConsoleInvocations(projectRoot: string): AgentInvocations {
  return defineAgentInvocations({
    metadataContent: consoleMetadataContent,
    store: createLibsqlAgentInvocationStore({
      maxAgeMs: false,
      maxRecords: false,
      ...resolveConsoleDatabaseOptions(projectRoot),
    }),
  })
}

function createConsoleFixtureInvocationsFromSnapshot(fixture: ConsoleFixture): AgentInvocations {
  const store = createMemoryAgentInvocationStore()
  for (const record of fixture.invocations) {
    const { cursor: _cursor, ...input } = record
    store.create(input)
  }
  return defineAgentInvocations({ metadataContent: consoleMetadataContent, store })
}

export function createConsoleFixtureInvocations(file: string): AgentInvocations {
  return createConsoleFixtureInvocationsFromSnapshot(readConsoleFixture(file))
}

export function installConsoleInvocations(projectRoot: string): AgentInvocations {
  const resolvedRoot = resolve(projectRoot)
  const identity = createConsoleInvocationsIdentity(resolvedRoot)
  const installed = resolveConsoleInvocations()
  if (installed && resolveConsoleInvocationsIdentity() === identity) return installed
  const invocations = createConsoleInvocations(resolvedRoot)
  installConsoleInvocationFallback(invocations, resolvedRoot, globalThis, identity)
  return invocations
}

export function installConsoleFixtureInvocations(
  projectRoot: string,
  file: string,
  generatedFixture?: ConsoleFixture,
  generatedRevision?: string,
): AgentInvocations {
  const resolvedRoot = resolve(projectRoot)
  const resolvedFile = resolve(file)
  const identity = createConsoleInvocationsIdentity(resolvedRoot, resolvedFile)
  const fixture = generatedFixture ?? readConsoleFixture(resolvedFile)
  const revision = generatedRevision ?? consoleFixtureRevision(fixture)
  const installed = resolveConsoleInvocations()
  if (installed && resolveConsoleInvocationsIdentity() === identity && resolveConsoleInvocationsRevision(identity) === revision) return installed
  const invocations = createConsoleFixtureInvocationsFromSnapshot(fixture)
  installConsoleInvocationFallback(invocations, resolvedRoot, globalThis, identity, revision)
  return invocations
}
