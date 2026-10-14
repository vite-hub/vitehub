import { expect, it } from "vitest"
import { createCursorHistory } from "../src/runtime/cursor-history.ts"

it.each(["vhc:provider-cursor", "vhc:1:not-json", "vhc:1:%7B%7D", "vhc:1:%"])("preserves opaque provider cursor %s", (cursor) => {
  expect(createCursorHistory().take(cursor)).toEqual({ providerCursor: cursor, history: new Set([cursor]) })
})

it("preserves portable history across instances", () => {
  const cursor = createCursorHistory().store("vhc:next", new Set(["first", "vhc:next"]))
  expect(createCursorHistory().take(cursor)).toEqual({ providerCursor: "vhc:next", history: new Set(["first", "vhc:next"]) })
})

it("rejects oversized raw and portable cursors before decoding", () => {
  expect(() => createCursorHistory().take(`vhc:${"x".repeat(8 * 1_024)}`)).toThrow("maximum size")
  expect(() => createCursorHistory().take(`vhc:1:${"x".repeat(128 * 1_024)}`)).toThrow("maximum size")
})
