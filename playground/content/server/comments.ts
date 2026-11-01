import { defineComments } from "vite-hub/comments"
import { cmsCommentsAuthorize } from "vite-hub/cms/access"

// The CMS roles decide: commenters, editors, publishers, and admins read, comment, and resolve on the public pages.
// Visitors who are not signed in see no overlay. Open any page with ?vitehub to turn comment mode on; inline edits also
// need write access in `content.authorize`.
export const comments = defineComments({
  authorize: cmsCommentsAuthorize,
})
