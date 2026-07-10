import { describe, expect, it } from "vitest"

import * as v from "@vite-hub/agent/valibot"

describe("agent Valibot export", () => {
  it("provides a Standard Schema validator for tool inputs", () => {
    const schema = v.object({
      message: v.pipe(v.string(), v.minLength(1)),
    })

    expect(v.safeParse(schema, { message: "Small friction." }).success).toBe(true)
    expect(v.safeParse(schema, { message: "" }).success).toBe(false)
  })
})
