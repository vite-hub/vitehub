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
  })

  it("validates methods and definition sections", () => {
    installConsoleDefinitions("/project", { workflows: [] })

    expect(() => definitionsHandler(event("", "POST"))).toThrow(expect.objectContaining({ statusCode: 405 }))
    expect(() => definitionsHandler(event())).toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => definitionsHandler(event("?section=queues"))).toThrow(expect.objectContaining({ statusCode: 400 }))
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
