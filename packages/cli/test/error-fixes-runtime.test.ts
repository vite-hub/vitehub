import { expect, it } from "vitest"

import { cliErrorDiagnostics } from "../src/error-diagnostics.ts"

const fixedCodes = [
  "CLI_R0001",
  "CLI_R0002",
] as const

const credentialCodes = [
  "SETUP_DEPLOY_CREDENTIALS_MISSING",
  "SETUP_DEPLOYMENTS_CREDENTIALS_MISSING",
  "SETUP_LINK_CREDENTIALS_MISSING",
] as const

it("gives each CLI code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = cliErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/development/diagnostics/${code.toLowerCase()}`)
  }
})

it("gives the split CLI codes a fix", () => {
  expect(cliErrorDiagnostics.CLI_HOST_RESPONSE_INVALID({ host: "vercel" })).toMatchObject({ fix: expect.stringContaining("@vite-hub/cli"), why: expect.stringContaining("vercel") })
  expect(cliErrorDiagnostics.CLI_SETUP_FAILED({ message: "boom" })).toMatchObject({ fix: expect.stringMatching(/\S/), why: "boom" })
})

it("keeps the host fix of a missing credential, and documents a general one", () => {
  for (const code of credentialCodes) {
    expect(cliErrorDiagnostics[code]({ host: "vercel" }).fix, code).toContain("VERCEL_TOKEN")
    expect(cliErrorDiagnostics[code]({ host: "vercel" }).docs, code).toBe(`https://vitehub.dev/docs/development/diagnostics/${code.toLowerCase()}`)
  }
  expect(cliErrorDiagnostics.SETUP_LINK_CREDENTIALS_MISSING({ fix: "Set VERCEL_TOKEN.", host: "vercel" }).fix).toBe("Set VERCEL_TOKEN.")
})
