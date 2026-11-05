import { describe, expectTypeOf, it } from "vitest"

import { defineComments } from "../src/index.ts"

import type { CommentAction, CommentsAuthorizeContext, CommentsErrorCode, CommentsGitHubAccess, CommentSubject } from "../src/index.ts"

const comments = defineComments()

it("gives policies the subject and one set of actions", () => {
  expectTypeOf<CommentsAuthorizeContext["subject"]>().toEqualTypeOf<CommentSubject | undefined>()
  expectTypeOf<CommentAction>().toEqualTypeOf<"read" | "write" | "resolve" | "delete">()
  defineComments({ authorize: ({ subject }) => subject?.kind === "page" })
})

it("types GitHub access in a policy alongside custom identity", () => {
  defineComments({
    identify: () => ({ id: "ana" }),
    authorize: ({ user }) => {
      expectTypeOf(user?.github).toEqualTypeOf<CommentsGitHubAccess | undefined>()
      return user?.github?.write === true
    },
  })
})

describe("Comments error unions", () => {
  it("types each method with the codes it returns", async () => {
    const [listError] = await comments.list()
    expectTypeOf(listError?.code).toEqualTypeOf<"COMMENTS_NOT_INSTALLED" | "COMMENTS_INVALID_INPUT" | undefined>()
    const [replyError] = await comments.reply("t", { body: "", author: { id: "a", name: "A" } })
    expectTypeOf(replyError?.code).toEqualTypeOf<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND" | "COMMENTS_INVALID_INPUT" | "COMMENTS_RESOLVED" | undefined>()
    const [getError, thread] = await comments.get("t")
    if (!getError) expectTypeOf(thread.status).toEqualTypeOf<"open" | "resolved">()
    expectTypeOf<"COMMENTS_FIELD_LOCKED">().toExtend<CommentsErrorCode>()
  })
})
