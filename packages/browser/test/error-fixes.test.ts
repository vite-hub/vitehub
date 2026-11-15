import { expect, it } from "vitest"

import { browserErrorDiagnostics } from "../src/error-diagnostics.ts"
import { hubBrowser } from "../src/vite.ts"

const fixedCodes = ["BROWSER_B0001", "BROWSER_B0002"] as const

it("gives each Browser build code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = browserErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/browser/diagnostics/${code.toLowerCase()}`)
  }
})

it("names the binding option when the Browser binding is not a Cloudflare binding name", () => {
  expect(() => hubBrowser({ binding: "my-browser" })).toThrow(expect.objectContaining({
    code: "BROWSER_B0001",
    fix: expect.stringContaining("`browser: { binding }`"),
  }))
})

it("names the engine option when the Browser engine is unknown", () => {
  // SAFETY: JavaScript config can pass an engine that the type does not allow.
  expect(() => hubBrowser({ engine: "webkit" as "chromium" })).toThrow(expect.objectContaining({
    code: "BROWSER_B0002",
    fix: expect.stringContaining("`browser: { engine }`"),
  }))
})
