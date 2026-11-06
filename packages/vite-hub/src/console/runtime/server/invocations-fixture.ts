import { resolve } from "node:path"

import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"

import { createConsoleInvocationsIdentity, installConsoleInvocationFallback, resolveConsoleInvocationsByIdentity, resolveConsoleInvocationsRevision } from "../../internal.ts"
import { consoleFixtureRevision, readConsoleFixture } from "../../fixture.ts"
import { consoleMetadataContent } from "./invocations.ts"

import type { AgentInvocations } from "@vite-hub/agent"
import type { ConsoleFixture } from "../../fixture.ts"

// Fixture journals serve recorded invocations in development. They read the fixture file, so they have their own
// module and stay out of the server startup graph.

function createConsoleFixtureInvocationsFromSnapshot(fixture: ConsoleFixture): AgentInvocations {
  const store = createMemoryAgentInvocationStore()
  for (const record of fixture.invocations) {
    const { cursor: _cursor, ...input } = record
    store.create(input)
  }
  return defineAgentInvocations({ configuration: "content", metadataContent: consoleMetadataContent, store })
}

export function createConsoleFixtureInvocations(file: string): AgentInvocations {
  return createConsoleFixtureInvocationsFromSnapshot(readConsoleFixture(file))
}

export function installConsoleFixtureInvocations(
  projectRoot: string,
  file: string,
  generatedFixture?: ConsoleFixture,
  generatedRevision?: string,
  runtimeBinding?: string,
): AgentInvocations {
  const resolvedRoot = resolve(projectRoot)
  const resolvedFile = resolve(file)
  const fixture = generatedFixture ?? readConsoleFixture(resolvedFile)
  const revision = generatedRevision ?? consoleFixtureRevision(fixture)
  const identity = createConsoleInvocationsIdentity(resolvedRoot, resolvedFile, revision, runtimeBinding)
  const installed = resolveConsoleInvocationsByIdentity(identity)
  if (installed && resolveConsoleInvocationsRevision(identity) === revision) {
    installConsoleInvocationFallback(installed, resolvedRoot, globalThis, identity, revision)
    return installed
  }
  const invocations = createConsoleFixtureInvocationsFromSnapshot(fixture)
  installConsoleInvocationFallback(invocations, resolvedRoot, globalThis, identity, revision)
  return invocations
}
