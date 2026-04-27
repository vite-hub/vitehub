import { describe, expect, it } from "vitest"

import { validatePayload } from "../src/runtime/payload.ts"

describe("workflow payload validation", () => {
  it("accepts safeParse schemas", async () => {
    await expect(validatePayload("hello", {
      safeParse: value => ({ success: true, data: String(value) }),
    })).resolves.toBe("hello")
  })

  it("accepts parse schemas", async () => {
    await expect(validatePayload("hello", {
      parse: value => String(value).toUpperCase(),
    })).resolves.toBe("HELLO")
  })

  it("accepts parser functions", async () => {
    await expect(validatePayload("hello", value => String(value).length)).resolves.toBe(5)
  })
})
