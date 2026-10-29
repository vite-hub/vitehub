import { describe, expectTypeOf, it } from "vitest"

import { defineComments } from "../src/index.ts"

import type { CommentsAuthorizeContext, CommentsErrorCode } from "../src/index.ts"

const comments = defineComments()

it("exposes live scopes in the shared authorization policy", () => {
  expectTypeOf<CommentsAuthorizeContext["scope"]>().toEqualTypeOf<string | undefined>()
  defineComments({ authorize: ({ scope }) => scope === "pages" })
})

describe("Comments error unions", () => {
  it("types each method with the codes it returns", async () => {
    const [listError] = await comments.list()
    expectTypeOf(listError?.code).toEqualTypeOf<"COMMENTS_NOT_INSTALLED" | undefined>()
    const [replyError] = await comments.reply("t", { body: "", author: { id: "a", name: "A" } })
    expectTypeOf(replyError?.code).toEqualTypeOf<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND" | "COMMENTS_INVALID_INPUT" | "COMMENTS_RESOLVED" | undefined>()
    const [getError, thread] = await comments.get("t")
    if (!getError) expectTypeOf(thread.status).toEqualTypeOf<"open" | "resolved">()
    expectTypeOf<"COMMENTS_FIELD_LOCKED">().toExtend<CommentsErrorCode>()
  })
})
