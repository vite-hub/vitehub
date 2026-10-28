import { defineErrors } from "@vite-hub/runtime"

// Keep published codes stable. Each code has a heading on the docs page.
export const commentsErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/comments/limits-and-errors",
  codes: {
    COMMENTS_NOT_INSTALLED: {
      why: "The Comments runtime has no Database yet. ViteHub installs it from `server/comments.ts` when the server starts.",
      fix: "Call the method from a server route or a Nitro plugin of the app, not at import time, and enable a Database with `vitehub({ database: true })`.",
    },
    COMMENTS_NOT_FOUND: {
      why: ({ id }: { id: string }) => `No comment thread or comment has the id ${JSON.stringify(id)}.`,
      fix: "List the threads with `comments.list()` and use one of their ids. A deleted thread does not come back.",
    },
    COMMENTS_INVALID_INPUT: {
      why: ({ issue }: { issue: string }) => `The comment input is not valid: ${issue}`,
      fix: "Send a page path that starts with `/`, an anchor from the overlay, and a body of 1 to 4,000 characters.",
    },
    COMMENTS_FORBIDDEN: {
      why: ({ action }: { action: string }) => `The \`authorize\` policy of \`defineComments()\` denied \`${action}\` for this user.`,
      fix: "Sign in as a user that the policy allows, or change `authorize` in `server/comments.ts`.",
    },
    COMMENTS_RESOLVED: {
      why: "The thread is resolved, so it takes no new replies.",
      fix: "Reopen the thread with `comments.reopen(id)` first.",
    },
    COMMENTS_CONTENT_MISSING: {
      why: "Inline edits need Content, and the app has no `server/content.ts` with document collections.",
      fix: "Define collections with `defineContent()` in `server/content.ts`, and mark rendered fields with `contentField()`.",
    },
    COMMENTS_FIELD_INVALID: {
      why: ({ field }: { field: string }) => `${JSON.stringify(field)} is not a Content field address, or its collection, document, or field does not exist.`,
      fix: "Write the attribute with `contentField(collection, id, field)` from `vite-hub/content/client`, so the address matches a collection of `server/content.ts`.",
    },
    COMMENTS_FIELD_NOT_EDITABLE: {
      why: ({ field }: { field: string }) => `The draft value of ${JSON.stringify(field)} is not a string, so it cannot be edited as text on the page.`,
      fix: "Edit the field in the Console Content editor.",
    },
    COMMENTS_FIELD_FORBIDDEN: {
      why: ({ field }: { field: string }) => `\`content.can()\` denied \`write\` on the document of ${JSON.stringify(field)} for this user.`,
      fix: "Sign in as a user that the `authorize` policy of `defineContent()` lets write the collection.",
    },
    COMMENTS_FIELD_CONFLICT: {
      why: ({ field }: { field: string }) => `The document of ${JSON.stringify(field)} changed after the page read it.`,
      fix: "Open the field again to read the current draft, then repeat the edit.",
    },
    COMMENTS_FIELD_LOCKED: {
      why: ({ holder }: { holder: string }) => `${holder} holds the edit lease of this document in the Console.`,
      fix: "Wait until they close the document, or edit it together with them in the Console.",
    },
  },
})
