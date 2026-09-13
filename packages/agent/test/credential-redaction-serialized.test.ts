import { expect, it } from "vitest"
import { consumeCredentialAssignment, pendingCredentialAssignmentState, redactCredentialText } from "../src/internal/credential-redaction.ts"

it.each(["password", "apiKey", "credentials", "clientSecret"])("redacts serialized %s while preserving safe fields", (key) => {
  for (const slashes of [1, 3, 7]) {
    const quote = "\\".repeat(slashes) + '"'
    const input = `{${quote}${key}${quote}:${quote}correct horse${quote},${quote}status${quote}:${quote}ok${quote}}`
    expect(redactCredentialText(input)).toBe(input.replace("correct horse", "[REDACTED]"))
  }
})

it("retains embedded escaped quotes inside serialized credentials", () => {
  const input = String.raw`{\"password\":\"correct \\\"horse\\\" battery\",\"status\":\"ok\"}`
  expect(redactCredentialText(input)).toBe(String.raw`{\"password\":\"[REDACTED]\",\"status\":\"ok\"}`)
})

it("keeps serialized credential state across value chunks", () => {
  const prefix = String.raw`{\"password\":\"correct `
  const rest = String.raw`horse\",\"status\":\"ok\"}`
  for (let split = 0; split < rest.indexOf(","); split++) {
    const state = pendingCredentialAssignmentState(prefix)!
    expect(state).toBeDefined()
    expect(consumeCredentialAssignment(rest.slice(0, split), state)).toBe(split)
    expect(consumeCredentialAssignment(rest.slice(split), state)).toBe(rest.indexOf(",") - split)
  }
})

it("preserves shell concatenation when quotes are escaped", () => {
  expect(redactCredentialText(String.raw`PASSWORD=\"abc\"suffix;status=ok`)).toBe("PASSWORD=[REDACTED];status=ok")
})
