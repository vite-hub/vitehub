import { Diagnostic } from "nostics"
import { expect, it, vi } from "vitest"
import { loadDiagnosticCopy } from "../../runtime/test/fixtures/diagnostic-copy.ts"
import { createEmail } from "../src/client.ts"

it("throws configuration diagnostics from a separately bundled driver before sending", async () => {
  const copy = await loadDiagnosticCopy(new URL("../", import.meta.url))
  const failure = copy.create({ code: "EMAIL_NOT_CONFIGURED", why: "Missing API key" })
  expect(failure).not.toBeInstanceOf(Diagnostic)
  const send = vi.fn(async () => ({ data: { at: new Date(), driver: "copy", id: "unused" }, error: null }))
  const client = createEmail({ driver: { name: "copy", initialize() { throw failure }, send } })
  await expect(client.send({ from: "from@example.test", to: "to@example.test", subject: "Example", text: "Hello" }))
    .rejects.toBe(failure)
  expect(send).not.toHaveBeenCalled()
})
