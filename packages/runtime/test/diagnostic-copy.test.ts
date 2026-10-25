import { Diagnostic } from "nostics"
import { expect, it } from "vitest"
import { loadDiagnosticCopy } from "./fixtures/diagnostic-copy.ts"
import { isRuntimeDiagnostic, ViteHubError } from "../src/index.ts"

it("recognizes a separately bundled Nostics error without accepting serialized or unreadable records", async () => {
  const copy = await loadDiagnosticCopy(new URL("../", import.meta.url))
  const failure = copy.create({ code: "EXAMPLE_INVALID", why: "Invalid input", fix: "Provide a value" })
  expect(failure).not.toBeInstanceOf(Diagnostic)
  expect(isRuntimeDiagnostic(failure)).toBe(true)
  expect(isRuntimeDiagnostic(new Diagnostic({ code: "LOCAL", why: "Local input" }))).toBe(true)
  expect(isRuntimeDiagnostic(JSON.parse(JSON.stringify(failure)))).toBe(false)
  expect(isRuntimeDiagnostic(new ViteHubError("EXAMPLE_INVALID", "Application error"))).toBe(false)
  expect(isRuntimeDiagnostic(Object.assign(new Error("Ordinary error"), { code: "EXAMPLE_INVALID" }))).toBe(false)
  const hostile = new Proxy(new Error("Unreadable"), { get() { throw new Error("Property access failed") } })
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  expect(isRuntimeDiagnostic(hostile)).toBe(false)
  expect(isRuntimeDiagnostic(revoked.proxy)).toBe(false)
})
