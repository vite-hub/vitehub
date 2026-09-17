import { expect, it } from "vitest"
import { credentialTextMayContinue, pendingCredentialTextSuffix, redactCredentialText } from "../src/internal/credential-redaction.ts"

it.each(["API_TOKEN ?", "PASSWORD +", "_API_TOKEN ?", "__PASSWORD +"])("retains partial compound assignments: %s", (prefix) => {
  expect(credentialTextMayContinue(prefix)).toBe(true)
  expect(pendingCredentialTextSuffix(`safe text ${prefix}`)).toBe(prefix)
  expect(redactCredentialText(`${prefix}= sensitive;status=ok`)).toBe(`${prefix}= [REDACTED];status=ok`)
})

it.each(["_API_TOKEN", "__PASSWORD"])("redacts leading underscores: %s", (key) => {
  expect(redactCredentialText(`${key}=sensitive;status=ok`)).toBe(`${key}=[REDACTED];status=ok`)
})

it.each(["maxTokens +", "status ?"])("preserves ordinary partial operators: %s", (prefix) => {
  expect(pendingCredentialTextSuffix(prefix)).toBeUndefined()
  expect(redactCredentialText(`${prefix}= 1000`)).toBe(`${prefix}= 1000`)
})
