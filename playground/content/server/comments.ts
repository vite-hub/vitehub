import { defineComments } from "vite-hub/comments"
import { cmsCommentsAuthorize } from "vite-hub/cms/access"

export const comments = defineComments({
  authorize: cmsCommentsAuthorize,
})
