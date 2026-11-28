import { describe, expect, it } from "vitest"

import { consoleCallerUser } from "../src/caller.ts"

describe("consoleCallerUser", () => {
  it("signs the email of a person who has one", () => {
    expect(consoleCallerUser({ id: "u1", name: "Ada", email: "ada@example.com", emailVerified: true })).toEqual({ id: "u1", name: "Ada", email: "ada@example.com", emailVerified: true })
  })

  it("leaves out the placeholder email of a passkey account", () => {
    expect(consoleCallerUser({ id: "u2", name: "Bob", email: "u2@passkey.invalid", emailVerified: false })).toEqual({ id: "u2", name: "Bob" })
    expect(consoleCallerUser({ id: "u3", name: "Cy", email: "U3@Passkey.Invalid" })).toEqual({ id: "u3", name: "Cy" })
  })
})
