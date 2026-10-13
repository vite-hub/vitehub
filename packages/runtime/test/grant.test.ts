import { describe, expect, expectTypeOf, it, vi } from "vitest"

import { defineGrant, type Grant } from "../src/internal/grant.ts"

const pathWrite = defineGrant("test.path-write", (path: string) => path)
const toolRun = defineGrant("test.tool-run", (input: { tool: string }) => Object.freeze({ ...input }))
const undefinedValue = defineGrant("test.undefined-value", () => undefined)

describe("defineGrant", () => {
  it("issues a frozen grant and returns its bound value", () => {
    const grant = pathWrite.issue("docs/guide.md", { label: "Workspace" })

    expect(Object.isFrozen(grant)).toBe(true)
    expect(grant.label).toBe("Workspace")
    expect(pathWrite.verify(grant)).toBe("docs/guide.md")
    expect(pathWrite.check(grant)).toBe("docs/guide.md")
    expectTypeOf(pathWrite.verify(grant)).toEqualTypeOf<string>()
    expectTypeOf(toolRun.verify(toolRun.issue({ tool: "search" }))).toEqualTypeOf<Readonly<{ tool: string }>>()
  })

  it("rejects forged grants and grants from another definition", () => {
    const forged = Object.freeze({ label: "Workspace" })
    const foreign = toolRun.issue({ tool: "search" })

    expect(pathWrite.check(forged)).toBeUndefined()
    expect(pathWrite.check(foreign)).toBeUndefined()
    expect(pathWrite.check("docs/guide.md")).toBeUndefined()
    // @ts-expect-error A plain object is not a grant.
    expect(() => pathWrite.verify(forged)).toThrow(expect.objectContaining({ code: "GRANT_REQUIRED", details: { kind: "test.path-write" } }))
    // @ts-expect-error A grant from another definition does not type-check.
    expect(() => pathWrite.verify(foreign)).toThrow(expect.objectContaining({ code: "GRANT_REQUIRED" }))
  })

  it("distinguishes a valid grant bound to undefined", () => {
    const grant = undefinedValue.issue("ignored")

    expect(undefinedValue.check(grant)).toBeUndefined()
    expect(undefinedValue.isValid(grant)).toBe(true)
    expect(undefinedValue.isValid(Object.freeze({}))).toBe(false)
    expect(undefinedValue.verify(grant)).toBeUndefined()
  })

  it("does not verify grants across definitions or copies with the same kind", async () => {
    const twin = defineGrant("test.path-write", (path: string) => path)
    vi.resetModules()
    const copy = await import("../src/internal/grant.ts")
    const copied = copy.defineGrant("test.path-write", (path: string) => path)
    const grant = pathWrite.issue("docs/guide.md")

    expect(copy.defineGrant).not.toBe(defineGrant)
    expect(twin.check(grant)).toBeUndefined()
    expect(copied.check(grant)).toBeUndefined()
    expect(pathWrite.check(copied.issue("docs/guide.md"))).toBeUndefined()
    expect(() => twin.verify(grant)).toThrow(expect.objectContaining({ code: "GRANT_REQUIRED" }))
  })

  it("consumes a grant once", () => {
    const grant = toolRun.issue({ tool: "search" })

    expect(toolRun.consume(grant)).toEqual({ tool: "search" })
    expect(toolRun.check(grant)).toBeUndefined()
    expect(() => toolRun.consume(grant)).toThrow(expect.objectContaining({ code: "GRANT_REQUIRED" }))
  })

  it("attaches a valid grant to an owner", () => {
    const request = {}
    const grant = pathWrite.issue("docs/guide.md")

    expect(pathWrite.attached(request)).toBeUndefined()
    pathWrite.attach(request, grant)
    expect(pathWrite.attached(request)).toBe(grant)
    expect(pathWrite.attached({})).toBeUndefined()
    // @ts-expect-error Only a grant of this definition can be attached.
    expect(() => pathWrite.attach({}, toolRun.issue({ tool: "search" }))).toThrow(expect.objectContaining({ code: "GRANT_REQUIRED" }))
    pathWrite.consume(grant)
    expect(pathWrite.attached(request)).toBeUndefined()
  })

  it("keeps the grant type nominal per kind", () => {
    expectTypeOf(pathWrite.issue("docs/guide.md")).toExtend<Grant<"test.path-write">>()
    expectTypeOf(toolRun.issue({ tool: "search" })).not.toExtend<Grant<"test.path-write">>()
    // @ts-expect-error The bound input type is inferred from the definition.
    pathWrite.issue(1)
  })
})
