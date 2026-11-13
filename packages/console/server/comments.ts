import { defineComments } from "vite-hub/comments"

import { commentersVariable, mayComment } from "../src/commenters.ts"

// Comments on the Console's own pages, for the people in VITEHUB_CONSOLE_COMMENTERS. See src/commenters.ts.
export const comments = defineComments({
  authorize: ({ user }) => mayComment(user, process.env[commentersVariable]),
})
