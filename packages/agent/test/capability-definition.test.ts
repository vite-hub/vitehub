import { describe, expect, it } from "vitest"
import { defineCapability } from "../src/capability-runtime.ts"

describe("typed Capability definitions", () => {
  it("preserves the definition and validates the id after runtime config is fixed", () => {
    const define = defineCapability<{ gatewayKey: string }>()
    const capability = { id: "configured" }
    expect(define(capability)).toBe(capability)
    expect(() => define({ id: "" })).toThrow()
  })

  it("still rejects an explicit undefined definition", () => {
    // @ts-expect-error Exercise the untyped JavaScript call boundary.
    expect(() => defineCapability(undefined)).toThrow()
  })
})
