import { describe, expect, it } from "vitest"

import { defineEmail } from "../src/index.ts"

import type { EmailDriver } from "../src/index.ts"

const driver: EmailDriver = {
  name: "fixture",
  async send() {
    return { id: "message-1" }
  },
}

describe("defineEmail", () => {
  it("keeps the driver-bearing definition intact", () => {
    const definition = { driver }
    expect(defineEmail(definition)).toBe(definition)
  })

  it.each([
    [{}, "driver"],
    [{ driver: { name: "", send: driver.send } }, "name"],
    [{ driver: { name: "fixture" } }, "send"],
  ])("rejects an invalid definition", (definition, field) => {
    expect(() => defineEmail(definition as never)).toThrow(field)
  })
})
