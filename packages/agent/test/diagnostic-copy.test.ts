import { Diagnostic } from "nostics"
import { expect, it } from "vitest"
import { loadDiagnosticCopy } from "../../runtime/test/fixtures/diagnostic-copy.ts"
import { isAgentTypeDiagnostic } from "../src/agent-diagnostics.ts"
import { toHttpErrorResponse } from "../src/http-error.ts"

it("classifies separately bundled input diagnostics without exposing their private message", async () => {
  const copy = await loadDiagnosticCopy(new URL("../", import.meta.url))
  const input = copy.create({ code: "AGENT_R0647", why: "Private invalid message detail" })
  const unknown = copy.create({ code: "APP_FAILED", why: "Private application detail" })
  expect(input).not.toBeInstanceOf(Diagnostic)
  expect(isAgentTypeDiagnostic(input)).toBe(true)
  expect(isAgentTypeDiagnostic(unknown)).toBe(false)
  expect(isAgentTypeDiagnostic(JSON.parse(JSON.stringify(input)))).toBe(false)
  const response = toHttpErrorResponse(input, isAgentTypeDiagnostic(input) ? 400 : 500)!
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ code: "INTERNAL", error: "Agent request failed." })
})
