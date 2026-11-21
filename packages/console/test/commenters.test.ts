import { describe, expect, it } from "vitest"

import { mayComment } from "../src/commenters.ts"

describe("mayComment", () => {
  const commenters = "maxi@example.com, Ana@Example.com"

  it("lets in the people whose email is in the list, in any case", () => {
    expect(mayComment({ id: "1", email: "maxi@example.com" }, commenters)).toBe(true)
    expect(mayComment({ id: "2", email: "ANA@example.com" }, commenters)).toBe(true)
  })

  it("keeps out other accounts, people without an email, passkey placeholders, and everyone without the variable", () => {
    expect(mayComment({ id: "3", email: "someone@example.com" }, commenters)).toBe(false)
    expect(mayComment({ id: "4" }, commenters)).toBe(false)
    expect(mayComment(null, commenters)).toBe(false)
    expect(mayComment({ id: "5", email: "x@passkey.invalid" }, "x@passkey.invalid")).toBe(false)
    expect(mayComment({ id: "1", email: "maxi@example.com" }, undefined)).toBe(false)
    expect(mayComment({ id: "6", email: "" }, ",")).toBe(false)
  })
})
