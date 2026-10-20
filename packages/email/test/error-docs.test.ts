import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"

import { emailErrorDiagnostics } from "../src/error-diagnostics.ts"

it("documents each Email error code with a docs heading", async () => {
  const page = await readFile(new URL("../../../docs/content/docs/email/limits-and-errors.md", import.meta.url), "utf8")

  for (const code of Object.keys(emailErrorDiagnostics)) {
    expect(page, code).toContain(`\n### ${code}\n`)
  }
  const error = emailErrorDiagnostics.EMAIL_TIMEOUT({ driver: "resend" })
  expect(error.docs).toBe("https://vitehub.dev/docs/email/limits-and-errors#email_timeout")
  expect(error.why).toBe("Email delivery through resend timed out.")
  expect(error.fix).not.toBe("")
})
