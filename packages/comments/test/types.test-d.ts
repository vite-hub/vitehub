import { describe, expectTypeOf, it } from "vitest"

import { defineComments } from "../src/index.ts"

import type { CommentsAuthorizeContext, CommentsErrorCode, CommentsGitHubAccess } from "../src/index.ts"
import type { CommentsDefinition } from "../src/operations-core/define.ts"
import type { DefineCommentsOptions as LiveCommentsOptions } from "../src/types.ts"

const comments = defineComments()

it("exposes live scopes in the shared authorization policy", () => {
  expectTypeOf<CommentsAuthorizeContext["scope"]>().toEqualTypeOf<string | undefined>()
  defineComments({ authorize: ({ scope }) => scope === "pages" })
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

it("accepts policies already typed for either entry form", () => {
  const live: LiveCommentsOptions = { authorize: ({ action }) => action === "comment" }
  const operations: CommentsDefinition = { authorize: ({ action }) => action === "write" }
  defineComments(live)
  defineComments(operations)
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
