import { defineComments } from "vite-hub/comments"

import { roleOf } from "./roles"

// Every playground user comments and resolves on the public pages. Visitors who are not signed in see no overlay.
// Open any page with ?vitehub to turn comment mode on; inline edits also need write access in `content.authorize`.
export const comments = defineComments({
  authorize: ({ user }) => roleOf(user) !== undefined,
})
