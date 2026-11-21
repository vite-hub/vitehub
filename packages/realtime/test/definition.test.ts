import { describe, expect, it } from "vitest"

import { defineRealtime } from "../src/definition.ts"
import type { RealtimeDefinition } from "../src/types.ts"

// Reads a definition as plain data, like a JavaScript file that has no types.
function untyped(value: object): RealtimeDefinition {
  return value as RealtimeDefinition
}

describe("defineRealtime() access", () => {
  it("requires authorize: true, authorize(), or access: 'public'", () => {
    expect(() => defineRealtime(untyped({ document: { workspace: "docs" } }))).toThrow(expect.objectContaining({ code: "REALTIME_MISSING_ACCESS" }))
    expect(() => defineRealtime(untyped({ document: { workspace: "docs" }, identify: () => null }))).toThrow(expect.objectContaining({ code: "REALTIME_MISSING_ACCESS" }))
    expect(() => defineRealtime(untyped({ document: false, origins: () => true }))).toThrow(expect.objectContaining({ code: "REALTIME_MISSING_ACCESS" }))

    expect(defineRealtime({ authorize: true, document: { workspace: "docs" } })).toMatchObject({ authorize: true })
    expect(defineRealtime({ authorize: () => true, document: false })).toMatchObject({ document: false })
    expect(defineRealtime({ access: "public", document: { workspace: "docs" }, identify: () => null, origins: () => true })).toMatchObject({ access: "public" })
  })

  it("rejects an access rule that is not clear", () => {
    expect(() => defineRealtime(untyped({ access: "private", document: false }))).toThrow(expect.objectContaining({ code: "REALTIME_INVALID_ACCESS" }))
    expect(() => defineRealtime(untyped({ access: "public", authorize: true, document: false }))).toThrow(expect.objectContaining({ code: "REALTIME_INVALID_ACCESS" }))
    expect(() => defineRealtime(untyped({ access: "public", authorize: () => true, document: false }))).toThrow(expect.objectContaining({ code: "REALTIME_INVALID_ACCESS" }))
    expect(() => defineRealtime(untyped({ authorize: false, document: false }))).toThrow(expect.objectContaining({ code: "REALTIME_INVALID_ACCESS" }))
    // The Auth session is a cookie, so another origin must not use it.
    expect(() => defineRealtime(untyped({ authorize: true, document: false, origins: () => true }))).toThrow(expect.objectContaining({ code: "REALTIME_INVALID_ACCESS" }))
    expect(defineRealtime({ authorize: true, document: false, identify: () => null, origins: () => true })).toMatchObject({ authorize: true })
  })

  it("rejects the removed auth key, so a callback never loads without the sign-in that auth required", () => {
    const removed = expect.objectContaining({ code: "REALTIME_INVALID_ACCESS", fix: expect.stringContaining("authorize: true") })
    expect(() => defineRealtime(untyped({ auth: true, document: false }))).toThrow(removed)
    expect(() => defineRealtime(untyped({ auth: true, authorize: () => true, document: false }))).toThrow(removed)
  })
})
