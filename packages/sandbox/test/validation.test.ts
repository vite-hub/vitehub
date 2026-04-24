import { describe, expect, it } from "vitest"

import { readValidatedPayload } from "../src/runtime/validation.ts"

describe("readValidatedPayload", () => {
  it("accepts standard-schema results with an empty issues array", async () => {
    await expect(readValidatedPayload("input", {
      "~standard": {
        validate: value => ({
          issues: [],
          value: `${value}-validated`,
        }),
      },
    })).resolves.toBe("input-validated")
  })

  it("rejects standard-schema results with issues", async () => {
    await expect(readValidatedPayload("input", {
      "~standard": {
        validate: () => ({
          issues: [{ message: "Invalid input" }],
          value: "input",
        }),
      },
    })).rejects.toThrow("Validation failed")
  })
})
