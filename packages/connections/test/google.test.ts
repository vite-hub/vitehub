import { describe, expect, it } from "vitest"

import { google } from "../src/google.ts"

const provider = google({ clientId: "client-id", clientSecret: "client-secret" })
function account(claims: unknown) {
  return provider.account({ access_token: "access-token", id_token: `header.${btoa(JSON.stringify(claims))}.signature` })
}

describe("Google account claims", () => {
  it("reads the account from the token endpoint claims", () => {
    expect(account({ sub: "account-1", email: "owner@example.com", aud: "client-id" })).toEqual({ id: "account-1", email: "owner@example.com" })
    expect(account({ sub: "account-1" })).toEqual({ id: "account-1" })
  })

  it("rejects claims that do not match the account contract", () => {
    for (const claims of [null, [], { email: "owner@example.com" }, { sub: 42 }, { sub: "account-1", email: 42 }]) {
      expect(account(claims)).toBeUndefined()
    }
    expect(provider.account({ access_token: "access-token", id_token: "invalid" })).toBeUndefined()
  })
})
