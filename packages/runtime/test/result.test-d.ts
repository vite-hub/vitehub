import { formatDiagnostic, type Diagnostic, type DiagnosticJSON } from "nostics"
import { describe, expectTypeOf, it } from "vitest"

import { defineErrors, runtimeErrorDiagnostics, type Result, type ResultError } from "@vite-hub/runtime"

const errors = defineErrors({
  docs: "https://vitehub.dev/docs/example",
  codes: {
    EXAMPLE_FAILED: { why: "The example failed.", fix: "Retry the example." },
    EXAMPLE_NOT_FOUND: {
      why: ({ key }: { key: string }) => `The key "${key}" does not exist.`,
      fix: "Write the key before you read it.",
    },
    EXAMPLE_RETRY: {
      why: ({ key }: { key: string }) => `The key "${key}" could not be read.`,
      fix: ({ delay }: { delay: number }) => `Retry in ${delay} seconds.`,
      data: ({ attempt }: { attempt: number }) => ({ attempt }),
    },
    EXAMPLE_BUSY: {
      why: "The example is busy.",
      fix: "Retry later.",
      data: { retryAfter: 10 },
    },
  },
})

declare function read(): Promise<Result<string, "EXAMPLE_FAILED" | "EXAMPLE_NOT_FOUND">>

describe("Result types", () => {
  it("types each catalog code", () => {
    expectTypeOf(errors.EXAMPLE_FAILED()).toEqualTypeOf<ResultError<"EXAMPLE_FAILED", undefined>>()
    expectTypeOf(errors.EXAMPLE_FAILED()).toMatchTypeOf<ResultError<"EXAMPLE_FAILED">>()
    expectTypeOf(errors.EXAMPLE_NOT_FOUND({ key: "settings" }).code).toEqualTypeOf<"EXAMPLE_NOT_FOUND">()
    // @ts-expect-error The catalog requires the `key` parameter of its `why`.
    errors.EXAMPLE_NOT_FOUND()
    // @ts-expect-error Unknown codes are not callable.
    errors.EXAMPLE_UNKNOWN()
    expectTypeOf(errors.EXAMPLE_FAILED().data).toEqualTypeOf<undefined>()
  })

  it("preserves static and computed diagnostic data", () => {
    const error = errors.EXAMPLE_RETRY({ key: "settings", delay: 10, attempt: 1 })
    expectTypeOf(error.data).toEqualTypeOf<{ attempt: number }>()
    expectTypeOf(error.code).toEqualTypeOf<"EXAMPLE_RETRY">()
    expectTypeOf(error).toEqualTypeOf<ResultError<"EXAMPLE_RETRY", { attempt: number }>>()
    expectTypeOf(error).toMatchTypeOf<ResultError>()
    expectTypeOf(error).toMatchTypeOf<ResultError<"EXAMPLE_RETRY">>()
    expectTypeOf(error).toMatchTypeOf<ResultError<"EXAMPLE_FAILED" | "EXAMPLE_RETRY">>()
    expectTypeOf<[typeof error, undefined]>().toMatchTypeOf<Result<string, "EXAMPLE_FAILED" | "EXAMPLE_RETRY">>()
    expectTypeOf(errors.EXAMPLE_BUSY().data).toEqualTypeOf<{ readonly retryAfter: 10 }>()
    // @ts-expect-error The why parameter is required.
    errors.EXAMPLE_RETRY({ delay: 10, attempt: 1 })
    // @ts-expect-error The fix parameter is required.
    errors.EXAMPLE_RETRY({ key: "settings", attempt: 1 })
    // @ts-expect-error The data parameter is required.
    errors.EXAMPLE_RETRY({ key: "settings", delay: 10 })
  })

  it("preserves Nostics consumers and literal serialized codes", () => {
    const error = errors.EXAMPLE_RETRY({ key: "settings", delay: 10, attempt: 1 })
    expectTypeOf(error).toMatchTypeOf<Diagnostic<{ attempt: number }>>()
    expectTypeOf(errors.EXAMPLE_FAILED()).toMatchTypeOf<Diagnostic<undefined>>()
    expectTypeOf(errors.EXAMPLE_BUSY()).toMatchTypeOf<Diagnostic<{ readonly retryAfter: 10 }>>()
    expectTypeOf(formatDiagnostic(error)).toEqualTypeOf<string>()
    const json = error.toJSON()
    expectTypeOf<ReturnType<typeof error.toJSON>>().toEqualTypeOf<typeof json>()
    expectTypeOf(json).toEqualTypeOf<DiagnosticJSON<{ attempt: number }> & {
      code: "EXAMPLE_RETRY"
      name: "EXAMPLE_RETRY"
      why: string
      fix: string | undefined
      docs: string | undefined
    }>()
  })

  it("keeps the Runtime catalog keys and parameters", () => {
    runtimeErrorDiagnostics.RUNTIME_R0015({ message: "Invalid request." })
    runtimeErrorDiagnostics.RUNTIME_R0016({ message: "Invalid context." })
    runtimeErrorDiagnostics.RUNTIME_R0001()
    runtimeErrorDiagnostics.RUNTIME_R0001({ message: "Invalid input.", cause: new Error("cause"), sources: ["input.ts:1:1"] })
    // @ts-expect-error Unknown codes are not callable.
    runtimeErrorDiagnostics.RUNTIME_R9999()
    // @ts-expect-error Runtime diagnostics only accept their declared parameters.
    runtimeErrorDiagnostics.RUNTIME_R0001({ unrelated: 42 })
  })

  it("narrows the data after an error check", async () => {
    const [error, value] = await read()
    if (error) {
      expectTypeOf(error.code).toEqualTypeOf<"EXAMPLE_FAILED" | "EXAMPLE_NOT_FOUND">()
      expectTypeOf(error.why).toEqualTypeOf<string>()
      expectTypeOf(error.fix).toEqualTypeOf<string | undefined>()
      expectTypeOf(error.docs).toEqualTypeOf<string | undefined>()
      expectTypeOf(error.data).toEqualTypeOf<unknown>()
      expectTypeOf(error.toJSON().code).toEqualTypeOf<"EXAMPLE_FAILED" | "EXAMPLE_NOT_FOUND">()
      expectTypeOf(error.toJSON().name).toEqualTypeOf<"EXAMPLE_FAILED" | "EXAMPLE_NOT_FOUND">()
      expectTypeOf(value).toEqualTypeOf<undefined>()
      return
    }
    expectTypeOf(error).toEqualTypeOf<undefined>()
    expectTypeOf(value).toEqualTypeOf<string>()
  })
})
