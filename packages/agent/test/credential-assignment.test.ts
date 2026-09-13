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

it.each([
  ['PASSWORD=', '$(printf supersecret)', ';status=ok'],
  ['PASSWORD=', '$(printf "%s" "$(printf supersecret)")', ';status=ok'],
  ['API_KEY=', '{"primary":"hunter2","backup":["secret","other"]}', ';status=ok'],
  ['API_TOKEN ?= ', 'sensitive', ';status=ok'],
  ['PASSWORD += ', 'secret', ';status=ok'],
  ['SSH_KEY_PASSPHRASE=', 'hunter2', ';status=ok'],
  ['AUTH=', 'hunter2', ';status=ok'],
  ['machine example.com login alice password ', 'hunter2', '\nstatus=ok'],
  ['machine example.com\nlogin alice\npassword ', 'hunter2', '\nstatus=ok'],
  ['default password ', 'hunter2', '\nstatus=ok'],
])("redacts complete assignment values after %s", (prefix, value, suffix) => {
  expect(redactCredentialText(prefix + value + suffix)).toBe(prefix + '[REDACTED]' + suffix)
  for (let split = 0; split <= value.length; split++) {
    const state = pendingCredentialAssignmentState(prefix + value.slice(0, split))
    expect(state).toBeDefined()
    const remaining = value.slice(split) + suffix
    expect(remaining.slice(consumeCredentialAssignment(remaining, state!))).toBe(suffix)
  }
})

it.each(['The password should remain private', 'password protection is enabled', 'Request auth details from the owner'])("preserves prose: %s", (value) => {
  expect(redactCredentialText(value)).toBe(value)
})
