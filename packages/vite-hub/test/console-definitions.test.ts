import { afterEach, describe, expect, it } from "vitest"

import {
  consoleDefinitionsKey,
  consoleDefinitionsRegistryKey,
  consoleDefinitionsRootKey,
  installConsoleDefinitionScope,
  resolveConsoleDefinitions,
} from "../src/console/internal.ts"
import definitionsHandler from "../src/console/runtime/server/definitions.get.ts"
import { installConsoleDefinitions } from "../src/console/runtime/server/definitions.ts"

import type { ConsoleDefinitionCatalog } from "../src/console/runtime/definitions.ts"
import type { ConsoleInvocationScope } from "../src/console/internal.ts"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

// SAFETY: ConsoleInvocationScope only adds optional symbol-keyed test state to the global object.
const scope = globalThis as ConsoleInvocationScope

function event(query = "", method = "GET"): ConsoleRequestEvent {
  return {
    method,
    node: { req: { method, url: `http://localhost/api/_vitehub/console/definitions${query}` } },
    req: { method, url: `http://localhost/api/_vitehub/console/definitions${query}` },
  }
}

function catalog(name: string): ConsoleDefinitionCatalog {
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
    workflows: [{
      fields: [{ label: "Steps", value: "prepare, publish" }],
      file: `server/workflows/${name}.workflow.ts`,
      name,
      source: "server-workflows",
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
  it("returns the installed read-only Workflow Definition catalog", () => {
    installConsoleDefinitions("/project", catalog("release"))

    expect(definitionsHandler(event("?section=workflows"))).toEqual({
      definitions: [{
        fields: [{ label: "Steps", value: "prepare, publish" }],
        file: "server/workflows/release.workflow.ts",
        name: "release",
        source: "server-workflows",
      }],
      section: "workflows",
    })
    expect(definitionsHandler(event("?section=databases"))).toEqual({
      definitions: [{
        fields: [
          { label: "Mode", value: "Default" },
          { label: "Tables", value: "users, sessions" },
        ],
        file: "server/databases/release.ts",
        name: "release",
        source: "server-database-default",
      }],
      section: "databases",
    })
    expect(definitionsHandler(event("?section=rate-limits"))).toEqual({
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
      section: "rate-limits",
    })
    expect(definitionsHandler(event("?section=queues"))).toEqual({
      definitions: [{
        fields: [],
        file: "server/queues/release.ts",
        name: "release",
        source: "server-queues",
      }],
      section: "queues",
    })
    expect(definitionsHandler(event("?section=schedules"))).toEqual({
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
      section: "schedules",
    })
  })

  it("validates methods and definition sections", () => {
    installConsoleDefinitions("/project", { workflows: [] })

    expect(() => definitionsHandler(event("", "POST"))).toThrow(expect.objectContaining({ statusCode: 405 }))
    expect(() => definitionsHandler(event())).toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => definitionsHandler(event("?section=future"))).toThrow(expect.objectContaining({ statusCode: 400 }))
  })

  it("isolates concurrent project catalogs across runtime realms", () => {
    const processRegistry = {}
    const firstScope: ConsoleInvocationScope = { process: processRegistry }
    const secondScope: ConsoleInvocationScope = { process: processRegistry }
    const first = catalog("first")
    const second = catalog("second")

    installConsoleDefinitionScope("/first", first, firstScope)
    installConsoleDefinitionScope("/second", second, secondScope)

    expect(resolveConsoleDefinitions(firstScope)).toBe(first)
    expect(resolveConsoleDefinitions(secondScope)).toBe(second)
    expect(resolveConsoleDefinitions({ process: processRegistry })).toBeUndefined()
  })
})
