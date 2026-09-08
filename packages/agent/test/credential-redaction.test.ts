import { describe, expect, it } from "vitest"
import { credentialTextMayContinue, redactCredentialText } from "../src/internal/credential-redaction.ts"

describe("structured credential redaction", () => {
  it.each([
    ['{"authorization":"Bearer sensitive-value","status":"ok"}', '{"authorization":"Bearer [REDACTED]","status":"ok"}'],
    ["'Basic sensitive-value', status=ok", "'Basic [REDACTED]', status=ok"],
    ['API_TOKEN="sensitive-value";status=ok', 'API_TOKEN="[REDACTED]";status=ok'],
    ["API_TOKEN=sensitive-value,status=ok", "API_TOKEN=[REDACTED],status=ok"],
    ["password=sensitive-value,status=ok", "password=[REDACTED],status=ok"],
    ["apiToken=sensitive-value;status=ok", "apiToken=[REDACTED];status=ok"],
    ['secret="sensitive-value",status=ok', 'secret="[REDACTED]",status=ok'],
    ["PASSWORD=sensitive-value,status=ok", "PASSWORD=[REDACTED],status=ok"],
    ["Bearer sensitive-value<status>ok</status>", "Bearer [REDACTED]<status>ok</status>"],
  ])("preserves the non-secret suffix of %s", (input, expected) => {
    expect(redactCredentialText(input)).toBe(expected)
    expect(credentialTextMayContinue(input)).toBe(false)
  })

  it.each(["Bearer sensitive", "Basic sensitive", "API_TOKEN=sensitive", "password=sensitive", "apiToken=sensitive", "secret=", "apiToken=", 'API_TOKEN="sensitive'])(
    "buffers the unfinished credential %s",
    (input) => expect(credentialTextMayContinue(input)).toBe(true),
  )
})
