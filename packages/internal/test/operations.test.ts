import * as v from "valibot"
import { describe, expect, it } from "vitest"

import { collectOperationContributions, createOperationRegistry, defineOperation, operationCliPath, operationInputJsonSchema, projectRootHash, runOperation } from "../src/operations.ts"

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

  it("lets a read-only grant run reads and dry runs, and refuses writes", async () => {
    const write = defineOperation({ description: "Write.", input: v.object({ dryRun: v.optional(v.boolean()) }), kind: "write", name: "demo.write", readOnlyWhen: input => input.dryRun === true, run: () => "done", section: "demo" })
    const registry = createOperationRegistry([{ operations: [greet, write] }])
    const readOnly = context(["demo:read"])
    expect(await runOperation(registry, "demo.greet", { name: "Ada" }, readOnly)).toEqual({ ok: true, value: "hello Ada" })
    expect(await runOperation(registry, "demo.write", { dryRun: true }, readOnly)).toEqual({ ok: true, value: "done" })
    const refused = await runOperation(registry, "demo.write", {}, readOnly)
    expect(refused).toMatchObject({ code: "INTERNAL_R0023", ok: false, status: 403 })
    expect(refused.ok === false && refused.message).toContain("read-only")
    // The full grant wins, and a grant of another section does not help.
    expect(await runOperation(registry, "demo.write", {}, context(["demo:read", "demo"]))).toMatchObject({ ok: true })
    expect(await runOperation(registry, "demo.greet", { name: "Ada" }, context(["other:read"]))).toMatchObject({ code: "INTERNAL_R0023", ok: false })
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

  it("collects contributions from plugins once, also from a function", async () => {
    const entry = { export: "ops", module: "@demo/operations" }
    expect(await collectOperationContributions([{ name: "a", vitehub: { operations: [entry] } }, { name: "b", vitehub: { operations: async () => [entry] } }, { name: "c" }, { name: "d", vitehub: { operations: () => [] } }])).toEqual([{ export: "ops", module: "@demo/operations", plugin: "a" }])
  })

  it("fails when two operations are the same CLI command", () => {
    const first = defineOperation({ ...greet, name: "agents.list", section: "agents" })
    const second = defineOperation({ ...greet, name: "invocations.list", section: "agents" })
    expect(() => createOperationRegistry([{ operations: [first, second], plugin: "vite-hub" }])).toThrowError(/both the CLI command `vitehub agents list`/)
    const moved = defineOperation({ ...second, cli: { namespace: "invocations" } })
    expect(operationCliPath(moved)).toEqual({ command: "list", namespace: "invocations" })
    expect(() => createOperationRegistry([{ operations: [first, moved] }])).not.toThrow()
    try {
      createOperationRegistry([{ operations: [first, second] }])
    }
    catch (error) {
      expect(error).toMatchObject({ code: "INTERNAL_B0049" })
    }
  })

  it("rejects a request limit below the default and a key that clashes with a CLI flag", () => {
    expect(() => defineOperation({ ...greet, maxRequestBytes: 1024 })).toThrowError(/can only raise the limit above 65536 bytes/)
    expect(defineOperation({ ...greet, maxRequestBytes: 128 * 1024 }).maxRequestBytes).toBe(128 * 1024)
    for (const key of ["url", "timeout", "json", "yes", "input"]) {
      expect(() => defineOperation({ ...greet, input: v.object({ [key]: v.string() }) as never }), key).toThrowError(new RegExp(`input key "${key}" is a CLI flag`))
    }
    try {
      defineOperation({ ...greet, input: v.object({ url: v.string() }) as never })
    }
    catch (error) {
      expect(error).toMatchObject({ code: "INTERNAL_R0020" })
    }
  })

  it("hashes a project root the same with or without a trailing slash", () => {
    expect(projectRootHash("/home/app")).toBe(projectRootHash("/home/app/"))
    expect(projectRootHash("/home/app")).not.toBe(projectRootHash("/home/other"))
  })

  it("keeps readOnlyWhen for the CLI and agents", () => {
    const publish = defineOperation({ ...greet, kind: "destructive", name: "demo.publish", readOnlyWhen: () => true })
    expect(publish.readOnlyWhen?.({ name: "x" })).toBe(true)
    expect(() => defineOperation({ ...greet, readOnlyWhen: "yes" as never })).toThrowError(/readOnlyWhen must be a function/)
  })
})


it.each(["inspect", "provision"])("rejects %s as an operation namespace in the registry", namespace => {
  const operation = defineOperation({
    name: `${namespace}.custom`, description: "Reserved namespace.", kind: "read", section: namespace,
    input: v.object({}), run: () => true,
  })
  expect(() => createOperationRegistry([{ operations: [operation] }])).toThrowError(/reserved/)
})
