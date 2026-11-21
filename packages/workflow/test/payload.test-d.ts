import { expectTypeOf, it } from "vitest"

import { readRequestPayload, readValidatedPayload } from "../src/runtime/payload.ts"

it("does not let the caller name the type of an unchecked request body", () => {
  const request = new Request("https://example.com/workflow", { method: "POST" })
  expectTypeOf(readRequestPayload(request)).toEqualTypeOf<Promise<unknown>>()
  // @ts-expect-error The body is not checked. Pass it to `validatePayload()`, or call `readValidatedPayload()`.
  void readRequestPayload<{ email: string }>(request)
  expectTypeOf(readValidatedPayload(request, (value: unknown) => String(value))).toEqualTypeOf<Promise<string>>()
})
