import { expect, it } from "vitest"

import { formsClientDiagnostics } from "../src/client-diagnostics.ts"
import { submitForm } from "../src/client.ts"

it.each(["FORMS_SUBMIT_FAILED", "FORMS_SUBMIT_INVALID"] as const)("gives %s a fix and its own docs page", (code) => {
  const error = formsClientDiagnostics[code]({ reason: "r" })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/forms/diagnostics/${code.toLowerCase()}`)
})

it("returns FORMS_SUBMIT_FAILED with status 0 when the request gets no answer", async () => {
  const [error] = await submitForm("contact", { message: "Hi" }, { fetch: async () => { throw new TypeError("Failed to fetch") } })
  expect(error).toMatchObject({ code: "FORMS_SUBMIT_FAILED", fix: expect.stringContaining("error.status"), message: "Failed to fetch", status: 0 })
})
