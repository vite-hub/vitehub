import { describe, expect, it } from "vitest"
import { chatFinalReplyNotices, chatFinalReplyNoticesContextKey } from "../src/internal/chat-finish-delivery.ts"

describe("chatFinalReplyNotices", () => {
  it("ignores malformed context and notice lists", () => {
    expect(chatFinalReplyNotices(undefined)).toEqual([])
    for (const context of [null, "notice", [], { [chatFinalReplyNoticesContextKey]: "notice" }]) {
      expect(chatFinalReplyNotices({ context })).toEqual([])
    }
  })

  it("keeps nonempty notice text unchanged and excludes malformed entries", () => {
    expect(chatFinalReplyNotices({
      context: { [chatFinalReplyNoticesContextKey]: ["  notice  ", "", " \n\t ", null, 42, {}, "second"] },
    })).toEqual(["  notice  ", "second"])
  })
})
