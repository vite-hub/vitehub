import { validateCommentsDefinition } from "../operations-core/define.ts"

import type { Comments } from "../index.ts"

/**
 * The Comments definition of `server/comments.ts`: its `comments` export, else its default export. Both forms run the
 * same surfaces. The generated files call it, so a file without `defineComments()` fails with `COMMENTS_B0002`.
 */
export function commentsDefinitionOf(module: { comments?: unknown, default?: unknown }, file: string): Comments {
  // SAFETY: validateCommentsDefinition() accepts only objects that defineComments() marked, which are Comments.
  return validateCommentsDefinition(module.comments ?? module.default, file) as unknown as Comments
}
