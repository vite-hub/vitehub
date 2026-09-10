import { expect, it } from "vitest"
import { consumeCredentialAssignment, pendingCredentialAssignmentState, redactCredentialText } from "../src/internal/credential-redaction.ts"


it.each(["credential", "credentials", "CREDENTIALS", "authorization", "AUTHORIZATION"])("redacts serialized %s assignments", (key) => {
  expect(redactCredentialText(`${key}=hunter2;status=ok`)).toBe(`${key}=[REDACTED];status=ok`)
  expect(redactCredentialText(`{"${key}":"hunter2","status":"ok"}`)).toBe(`{"${key}":"[REDACTED]","status":"ok"}`)
  const prefix = `${key}="`
  const value = "hunter2 with spaces"
  const suffix = '";status=ok'
  for (let split = 0; split <= value.length; split++) {
    const state = pendingCredentialAssignmentState(prefix + value.slice(0, split))!
    expect(state).toBeDefined()
    const rest = value.slice(split) + suffix
    expect(rest.slice(consumeCredentialAssignment(rest, state))).toBe(";status=ok")
  }
})

it.each(["Bearer", "Basic", "Digest"])("preserves established %s authorization schemes", (scheme) => {
  expect(redactCredentialText(`Authorization: ${scheme} hunter2;status=ok`)).toBe(`Authorization: ${scheme} [REDACTED];status=ok`)
})

it("preserves ordinary credential prose and safe fields", () => {
  const value = 'Request credentials from the owner; {"status":"ok","token":"parser"}'
  expect(redactCredentialText(value)).toBe(value)
})
