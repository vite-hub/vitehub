import { expect, it } from "vitest"

import { authErrorDiagnostics } from "../src/error-diagnostics.ts"
import { stateless } from "../src/presets.ts"

it("gives each Auth code a fix and its own docs page", () => {
  // The named codes take typed params. Their own tests check them.
  for (const [code, create] of Object.entries(authErrorDiagnostics).filter(([code]) => /_[BCR]\d{4}$/.test(code))) {
    const error: { docs?: string, fix?: string } = Reflect.apply(create, undefined, [{ message: "message" }])
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/auth/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports an invalid stateless() maxAge with a code and a fix", () => {
  expect(() => stateless({ maxAge: 0 })).toThrow(expect.objectContaining({
    code: "AUTH_C0049",
    fix: expect.stringContaining("stateless({ maxAge: '7d' })"),
    message: expect.stringContaining("must be a positive whole number of seconds"),
  }))
})
