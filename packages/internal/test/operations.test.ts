import * as v from "valibot"
import { describe, expect, it } from "vitest"

import { collectOperationContributions, createOperationRegistry, defineOperation, operationInputJsonSchema, runOperation } from "../src/operations.ts"

import type { OperationContext } from "../src/operations.ts"

const greet = defineOperation({
  description: "Greet someone.",
  input: v.object({ name: v.string(), times: v.optional(v.number()) }),
  kind: "read",
  name: "demo.greet",
  run: input => `hello ${input.name}`,
  section: "demo",
})

function context(sections: "all" | string[]): OperationContext {
  return { access: { mode: "open", sections }, surface: "console", user: null }
}

describe("operations", () => {
  it("runs an operation by name with a checked input", async () => {
    const registry = createOperationRegistry([{ operations: [greet] }])
    expect(await runOperation(registry, "demo.greet", { name: "Ada" }, context("all"))).toEqual({ ok: true, value: "hello Ada" })
  })

  it("reports invalid input with a code and a fix", async () => {
    const registry = createOperationRegistry([{ operations: [greet] }])
    const result = await runOperation(registry, "demo.greet", { name: 1 }, context("all"))
    expect(result).toMatchObject({ code: "INTERNAL_R0022", ok: false, status: 400 })
    expect(result.ok === false && result.fix).toContain("--help")
  })

  it("denies a call outside the section of the access", async () => {
    const registry = createOperationRegistry([{ operations: [greet] }])
    expect(await runOperation(registry, "demo.greet", { name: "Ada" }, context(["other"]))).toMatchObject({ code: "INTERNAL_R0023", ok: false, status: 403 })
  })

  it("reads the section from the input when the section is a function", async () => {
    const dynamic = defineOperation({
      description: "Read a section.",
      input: v.object({ section: v.string() }),
      kind: "read",
      name: "demo.dynamic",
      run: input => input.section,
      section: input => input.section,
    })
    const registry = createOperationRegistry([{ operations: [dynamic] }])
    expect(await runOperation(registry, "demo.dynamic", { section: "a" }, context(["a"]))).toMatchObject({ ok: true })
    expect(await runOperation(registry, "demo.dynamic", { section: "b" }, context(["a"]))).toMatchObject({ ok: false, status: 403 })
  })

  it("keeps the diagnostic fields of a thrown error", async () => {
    const failing = defineOperation({
      description: "Fail.",
      input: v.object({}),
      kind: "write",
      name: "demo.fail",
      run: () => {
        throw Object.assign(new Error("Nothing to publish."), { code: "DEMO_R0001", details: { id: 1 }, fix: "Save a draft first.", status: 409 })
      },
      section: false,
    })
    const registry = createOperationRegistry([{ operations: [failing] }])
    expect(await runOperation(registry, "demo.fail", {}, context([]))).toEqual({
      code: "DEMO_R0001", details: { id: 1 }, fix: "Save a draft first.", message: "Nothing to publish.", ok: false, status: 409,
    })
  })

  it("fails the build when two operations share a name", () => {
    const other = defineOperation({ ...greet, run: () => "other" })
    expect(() => createOperationRegistry([{ operations: [greet], plugin: "a" }, { operations: [other], plugin: "b" }])).toThrowError(/Two operations are named "demo.greet" \(a and b\)/)
  })

  it("rejects a definition with a bad name", () => {
    expect(() => defineOperation({ ...greet, name: "Greet" })).toThrowError(/section\.verb/)
  })

  it("builds a JSON Schema for the input of a valibot schema", () => {
    expect(operationInputJsonSchema(greet)).toMatchObject({ properties: { name: { type: "string" }, times: { type: "number" } }, required: ["name"], type: "object" })
  })

  it("collects contributions from plugins once", () => {
    const entry = { export: "ops", module: "@demo/operations" }
    expect(collectOperationContributions([{ name: "a", vitehub: { operations: [entry] } }, { name: "b", vitehub: { operations: [entry] } }, { name: "c" }])).toEqual([{ export: "ops", module: "@demo/operations", plugin: "a" }])
  })
})
