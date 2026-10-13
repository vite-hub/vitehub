import { runInNewContext } from "node:vm"
import { afterEach, describe, expect, it } from "vitest"

import {
  consoleDefinitionsKey,
  consoleDefinitionsRegistryKey,
  consoleDefinitionsRootKey,
  installConsoleDefinitionScope,
  resolveConsoleDefinitions,
} from "../src/console/internal.ts"
import definitionsHandlerRoute from "../src/console/runtime/server/definitions.get.ts"
import { installConsoleDefinitions } from "../src/console/runtime/server/definitions.ts"

import type { ConsoleDefinitionSummary, ConsoleSectionCatalog } from "../src/console/runtime/definitions.ts"
import type { ConsoleInvocationScope } from "../src/console/internal.ts"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"
import { allowed } from "./support/console-access.ts"

const definitionsHandler = allowed(definitionsHandlerRoute)

// SAFETY: ConsoleInvocationScope only adds optional symbol-keyed test state to the global object.
const scope = globalThis as ConsoleInvocationScope

function event(query = "", method = "GET"): ConsoleRequestEvent {
  return {
    method,
    node: { req: { method, url: `http://localhost/api/_vitehub/console/definitions${query}` } },
    req: { method, url: `http://localhost/api/_vitehub/console/definitions${query}` },
  }
}

function catalog(name: string): ConsoleSectionCatalog["content"] {
  return Object.fromEntries(
    Object.entries(definitionSummaries(name)).map(([section, definitions]) => [section, { definitions, kind: "definition-catalog" as const }]),
  )
}

function definitionSummaries(name: string): Record<string, ConsoleDefinitionSummary[]> {
  return {
    databases: [{
      fields: [
        { label: "Mode", value: "Default" },
        { label: "Tables", value: "users, sessions" },
      ],
      file: `server/databases/${name}.ts`,
      name,
      source: "server-database-default",
    }],
    queues: [{
      fields: [],
      file: `server/queues/${name}.ts`,
      name,
      source: "server-queues",
    }],
    "rate-limits": [{
      fields: [
        { label: "Limit", value: "10" },
        { label: "Window", value: "1m" },
        { label: "Enforcement", value: "Best effort" },
        { label: "Provider failure", value: "Deny" },
        { label: "Source location", value: "12:5" },
      ],
      file: `server/api/${name}.ts`,
      name,
      source: "require-rate-limit",
    }],
    schedules: [{
      fields: [
        { label: "Kind", value: "Static schedule" },
        { label: "Cron", value: "0 9 * * *" },
        { label: "Time zone", value: "UTC" },
      ],
      file: `server/schedules/${name}.ts`,
      name,
      source: "server-schedules",
    }],
    sandboxes: [{
      fields: [{ label: "Kind", value: "Definition" }],
      file: `src/${name}.sandbox.ts`,
      name,
      source: "vite-suffix",
    }],
    workflows: [{
      fields: [{ label: "Steps", value: "prepare, publish" }],
      file: `server/workflows/${name}.workflow.ts`,
      name,
      source: "server-workflows",
    }],
    workspaces: [{
      fields: [
        { label: "Kind", value: "Workspace Definition" },
        { label: "Source root", value: `server/workspaces/${name}` },
      ],
      file: `server/workspaces/${name}/workspace.ts`,
      name,
      source: "server-workspaces-directory-config",
    }],
  }
}

afterEach(() => {
  delete scope[consoleDefinitionsKey]
  delete scope[consoleDefinitionsRootKey]
  Reflect.deleteProperty(process, consoleDefinitionsKey)
  Reflect.deleteProperty(process, consoleDefinitionsRootKey)
  Reflect.deleteProperty(process, consoleDefinitionsRegistryKey)
})

describe("Console definition inspection", () => {
  it("returns the installed read-only Workflow Definition catalog", async () => {
    installConsoleDefinitions("/project", catalog("release"))

    expect(await definitionsHandler(event("?section=workflows"))).toEqual({
      definitions: [{
        fields: [{ label: "Steps", value: "prepare, publish" }],
        file: "server/workflows/release.workflow.ts",
        name: "release",
        source: "server-workflows",
      }],
      kind: "definition-catalog",
      section: "workflows",
    })
    expect(await definitionsHandler(event("?section=databases"))).toEqual({
      definitions: [{
        fields: [
          { label: "Mode", value: "Default" },
          { label: "Tables", value: "users, sessions" },
        ],
        file: "server/databases/release.ts",
        name: "release",
        source: "server-database-default",
      }],
      kind: "definition-catalog",
      section: "databases",
    })
    expect(await definitionsHandler(event("?section=rate-limits"))).toEqual({
      definitions: [{
        fields: [
          { label: "Limit", value: "10" },
          { label: "Window", value: "1m" },
          { label: "Enforcement", value: "Best effort" },
          { label: "Provider failure", value: "Deny" },
          { label: "Source location", value: "12:5" },
        ],
        file: "server/api/release.ts",
        name: "release",
        source: "require-rate-limit",
      }],
      kind: "definition-catalog",
      section: "rate-limits",
    })
    expect(await definitionsHandler(event("?section=workspaces"))).toEqual({
      definitions: [{
        fields: [
          { label: "Kind", value: "Workspace Definition" },
          { label: "Source root", value: "server/workspaces/release" },
        ],
        file: "server/workspaces/release/workspace.ts",
        name: "release",
        source: "server-workspaces-directory-config",
      }],
      kind: "definition-catalog",
      section: "workspaces",
    })
    expect(await definitionsHandler(event("?section=queues"))).toEqual({
      definitions: [{
        fields: [],
        file: "server/queues/release.ts",
        name: "release",
        source: "server-queues",
      }],
      kind: "definition-catalog",
      section: "queues",
    })
    expect(await definitionsHandler(event("?section=schedules"))).toEqual({
      definitions: [{
        fields: [
          { label: "Kind", value: "Static schedule" },
          { label: "Cron", value: "0 9 * * *" },
          { label: "Time zone", value: "UTC" },
        ],
        file: "server/schedules/release.ts",
        name: "release",
        source: "server-schedules",
      }],
      kind: "definition-catalog",
      section: "schedules",
    })
    expect(await definitionsHandler(event("?section=sandboxes"))).toEqual({
      definitions: [{
        fields: [{ label: "Kind", value: "Definition" }],
        file: "src/release.sandbox.ts",
        name: "release",
        source: "vite-suffix",
      }],
      kind: "definition-catalog",
      section: "sandboxes",
    })
  })

  it("validates methods and definition sections", async () => {
    installConsoleDefinitions("/project", { workflows: { definitions: [], kind: "definition-catalog" } })

    await expect(definitionsHandler(event("", "POST"))).rejects.toThrow(expect.objectContaining({ statusCode: 405 }))
    await expect(definitionsHandler(event())).rejects.toThrow(expect.objectContaining({ statusCode: 400 }))
    await expect(definitionsHandler(event("?section=Future"))).rejects.toThrow(expect.objectContaining({ statusCode: 400 }))
    await expect(definitionsHandler(event("?section=future"))).rejects.toThrow(expect.objectContaining({ statusCode: 404 }))
    await expect(definitionsHandler(event("?section=constructor"))).rejects.toThrow(expect.objectContaining({ statusCode: 404 }))
  })

  it("merges request-time records into record-table sections", async () => {
    let runtimeRecords = [{ cells: { schedule: "digest" }, fields: [{ label: "State", value: "Enabled" }], id: "runtime:digest" }]
    installConsoleDefinitions("/project", {
      schedules: {
        kind: "record-table",
        records: [
          { cells: { schedule: "daily" }, fields: [], id: "definition:daily" },
          { cells: { schedule: "stale" }, fields: [], id: "runtime:digest" },
        ],
      },
      workflows: { definitions: [], kind: "definition-catalog" },
    }, [], {
      schedules: () => runtimeRecords,
      workflows: () => [{ cells: {}, fields: [], id: "ignored" }],
    })

    expect(await definitionsHandler(event("?section=schedules"))).toEqual({
      kind: "record-table",
      records: [
        { cells: { schedule: "daily" }, fields: [], id: "definition:daily" },
        { cells: { schedule: "digest" }, fields: [{ label: "State", value: "Enabled" }], id: "runtime:digest" },
      ],
      section: "schedules",
    })
    expect(await definitionsHandler(event("?section=workflows"))).toEqual({ definitions: [], kind: "definition-catalog", section: "workflows" })

    runtimeRecords = []
    expect(await definitionsHandler(event("?section=schedules"))).toEqual({
      kind: "record-table",
      records: [
        { cells: { schedule: "daily" }, fields: [], id: "definition:daily" },
        { cells: { schedule: "stale" }, fields: [], id: "runtime:digest" },
      ],
      section: "schedules",
    })
  })

  it("hides request-time reader errors", async () => {
    installConsoleDefinitions("/project", { schedules: { kind: "record-table", records: [] } }, [], {
      schedules: async () => {
        throw new Error("postgres://user:secret@example.test failed")
      },
    })

    const failure = definitionsHandler(event("?section=schedules"))
    await expect(failure).rejects.toThrow(expect.objectContaining({ statusCode: 503, statusMessage: "Runtime records are unavailable." }))
    await expect(failure).rejects.not.toThrow(/secret/)
  })

  it("resolves a refreshed project catalog before an older local fallback", () => {
    const processRegistry = {}
    const firstScope: ConsoleInvocationScope = { process: processRegistry }
    const nextScope: ConsoleInvocationScope = { process: processRegistry }
    const first: ConsoleSectionCatalog = { content: catalog("first"), sections: [] }
    const next: ConsoleSectionCatalog = { content: catalog("next"), sections: [] }

    expect(installConsoleDefinitionScope("/project", first, firstScope)).toBe(first)
    expect(resolveConsoleDefinitions({ process: processRegistry })).toBe(first)
    installConsoleDefinitionScope("/project", next, nextScope)

    expect(resolveConsoleDefinitions(firstScope)).toBe(next)
    expect(resolveConsoleDefinitions({ process: processRegistry })).toBe(next)
    expect(resolveConsoleDefinitions({ [consoleDefinitionsKey]: first })).toBe(first)
  })

  it("retains catalogs registered through a different JavaScript realm", () => {
    const first: ConsoleSectionCatalog = { content: catalog("first"), sections: [] }
    const second: ConsoleSectionCatalog = { content: catalog("second"), sections: [] }
    const foreignRegistry: unknown = runInNewContext("new Map(entries)", { entries: [["/first", first]] })
    const processRegistry = { [consoleDefinitionsRegistryKey]: foreignRegistry }
    const scope: ConsoleInvocationScope = { process: processRegistry }

    installConsoleDefinitionScope("/second", second, scope)

    expect(resolveConsoleDefinitions({ process: processRegistry, [consoleDefinitionsRootKey]: "/first" })).toBe(first)
    expect(resolveConsoleDefinitions(scope)).toBe(second)
    expect(resolveConsoleDefinitions({ process: processRegistry })).toBeUndefined()
  })

  it("uses the local catalog when the shared process has no matching project", () => {
    const processRegistry = {}
    const local: ConsoleSectionCatalog = { content: catalog("local"), sections: [] }
    const scope: ConsoleInvocationScope = { [consoleDefinitionsKey]: local, [consoleDefinitionsRootKey]: "/local", process: processRegistry }
    installConsoleDefinitionScope("/other", { content: catalog("other"), sections: [] }, { process: processRegistry })

    expect(resolveConsoleDefinitions(scope)).toBe(local)
  })

  it("isolates concurrent project catalogs across runtime realms", () => {
    const processRegistry = {}
    const firstScope: ConsoleInvocationScope = { process: processRegistry }
    const secondScope: ConsoleInvocationScope = { process: processRegistry }
    const first: ConsoleSectionCatalog = { content: catalog("first"), sections: [] }
    const second: ConsoleSectionCatalog = { content: catalog("second"), sections: [] }

    installConsoleDefinitionScope("/first", first, firstScope)
    installConsoleDefinitionScope("/second", second, secondScope)

    expect(resolveConsoleDefinitions(firstScope)).toBe(first)
    expect(resolveConsoleDefinitions(secondScope)).toBe(second)
    expect(resolveConsoleDefinitions({ process: processRegistry })).toBeUndefined()
  })
})
