import { describe, expectTypeOf, it } from "vitest"

import { defineErrors, type Result, type ResultError } from "../src/index.ts"

const errors = defineErrors({
  docs: "https://vitehub.dev/docs/example",
  codes: {
    EXAMPLE_FAILED: { why: "The example failed.", fix: "Retry the example." },
    EXAMPLE_NOT_FOUND: {
      why: ({ key }: { key: string }) => `The key "${key}" does not exist.`,
      fix: "Write the key before you read it.",
    },
  },
})

declare function read(): Promise<Result<string, "EXAMPLE_FAILED" | "EXAMPLE_NOT_FOUND">>

describe("Result types", () => {
  it("types each catalog code", () => {
    expectTypeOf(errors.EXAMPLE_FAILED()).toEqualTypeOf<ResultError<"EXAMPLE_FAILED">>()
    expectTypeOf(errors.EXAMPLE_NOT_FOUND({ key: "settings" }).code).toEqualTypeOf<"EXAMPLE_NOT_FOUND">()
    // @ts-expect-error The catalog requires the `key` parameter of its `why`.
    errors.EXAMPLE_NOT_FOUND()
  })

  it("narrows the data after an error check", async () => {
    const [error, value] = await read()
    if (error) {
      expectTypeOf(error.code).toEqualTypeOf<"EXAMPLE_FAILED" | "EXAMPLE_NOT_FOUND">()
      expectTypeOf(error.why).toEqualTypeOf<string>()
      expectTypeOf(error.fix).toEqualTypeOf<string | undefined>()
      expectTypeOf(error.docs).toEqualTypeOf<string | undefined>()
      expectTypeOf(value).toEqualTypeOf<undefined>()
      return
    }
    expectTypeOf(error).toEqualTypeOf<undefined>()
    expectTypeOf(value).toEqualTypeOf<string>()
  })
})
