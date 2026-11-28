import { describe, expect, it } from "vitest"

import { consoleOperationModules } from "../src/console/operation-modules.ts"
import { consoleFeatureFix, consoleFeatureNamespaces } from "../src/console/runtime/server/feature-operations.ts"
import { consoleOperations } from "../src/console/runtime/server/operations.ts"

const namespace = (name: string) => name.slice(0, name.indexOf("."))

describe("Console feature namespaces", () => {
  it.each(consoleOperationModules.map(entry => [entry.export, entry] as const))("lists every operation namespace of %s", async (name, entry) => {
    expect(Object.keys(consoleFeatureNamespaces)).toContain(name)
    const namespaces = [...new Set((await entry.load()).map(operation => namespace(operation.name)))].sort()
    expect([...consoleFeatureNamespaces[name as keyof typeof consoleFeatureNamespaces].namespaces].sort()).toEqual(namespaces)
  })

  it("has no entry without an operation module", () => {
    expect(Object.keys(consoleFeatureNamespaces).sort()).toEqual(consoleOperationModules.map(entry => entry.export).sort())
  })

  it("gives each namespace to one module, and none to an operation that every app serves", () => {
    const namespaces = Object.values(consoleFeatureNamespaces).flatMap(entry => entry.namespaces)
    expect(new Set(namespaces).size).toBe(namespaces.length)
    expect(consoleOperations.map(operation => operation.name).filter(name => consoleFeatureFix(name))).toEqual([])
  })
})
