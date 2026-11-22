import { defineComments } from "vite-hub/comments"

import { commentersVariable, mayComment } from "../src/commenters.ts"

export const comments = defineComments({
  authorize: ({ user }) => mayComment(user, process.env[commentersVariable]),
})
