import { cmsCommentsAuthorize } from "vite-hub/cms/access"
import { defineComments } from "vite-hub/comments"

// The CMS roles decide who reads, writes, resolves, and deletes comments. The comments live in the `content` Database.
export const comments = defineComments({ authorize: cmsCommentsAuthorize, database: "content" })
