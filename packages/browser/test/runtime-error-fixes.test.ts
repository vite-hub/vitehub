import { describe, expect, it } from "vitest"

import { createBrowser } from "../src/client.ts"
import { browserErrorDiagnostics } from "../src/error-diagnostics.ts"
import { localBrowser } from "../src/providers/local.ts"
import { defineBrowser } from "../src/runtime.ts"

type RuntimeErrorCode = Extract<keyof typeof browserErrorDiagnostics, `BROWSER_R${string}`>

const fixedCodes = Array.from({ length: 11 }, (_, index) => `BROWSER_R${String(index + 1).padStart(4, "0")}` as RuntimeErrorCode)

describe("Browser runtime error fixes", () => {
  it("gives each Browser runtime code a fix and its own docs page", () => {
    for (const code of fixedCodes) {
      const error = browserErrorDiagnostics[code]({ message: "m" })
      expect(error.fix, code).toMatch(/\S/)
      expect(error.docs, code).toBe(`https://vitehub.dev/docs/browser/diagnostics/${code.toLowerCase()}`)
    }
  })

  it("asks for a provider in createBrowser()", () => {
    expect(() => createBrowser({} as never)).toThrow(expect.objectContaining({
      code: "BROWSER_R0004",
      fix: expect.stringContaining("`createBrowser({ provider:"),
    }))
  })

  it("asks for the Chromium path in localBrowser()", () => {
    expect(() => localBrowser({} as never)).toThrow(expect.objectContaining({
      code: "BROWSER_R0007",
      fix: expect.stringContaining("`localBrowser({ executablePath })`"),
    }))
  })

  it("names the startupTimeout range", () => {
    expect(() => localBrowser({ executablePath: "/usr/bin/chromium", startupTimeout: 0 })).toThrow(expect.objectContaining({
      code: "BROWSER_R0008",
      fix: expect.stringContaining("`startupTimeout` of `localBrowser()`"),
    }))
  })

  it("asks for a Browser Definition handler", () => {
    expect(() => defineBrowser(undefined as never)).toThrow(expect.objectContaining({
      code: "BROWSER_R0010",
      fix: expect.stringContaining("`defineBrowser()`"),
    }))
  })
})
