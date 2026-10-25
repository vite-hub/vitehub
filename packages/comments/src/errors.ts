import { defineDiagnostics } from "nostics"

// Each code identifies one failure site. Keep published codes stable.
export const commentsErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/diagnostics",
  codes: {
    COMMENTS_R0001: {
      why: ({ target }: { target: string }) => `createAnchor() found nothing to anchor to for ${target}.`,
      fix: "Pass an element, a non-empty selection, or a point that is over an element of the page.",
    },
    COMMENTS_R0002: {
      why: ({ id }: { id: string }) => `The comment thread "${id}" does not exist.`,
      fix: "List the threads again, because someone may have deleted this one.",
    },
    COMMENTS_R0003: {
      why: ({ messageId }: { messageId: string }) => `The comment message "${messageId}" does not exist in this thread.`,
      fix: "Read the thread again, because someone may have deleted the message.",
    },
    COMMENTS_R0004: {
      why: "Only the author of a message can edit or delete it.",
      fix: "Sign in as the author, or ask them to change the message.",
    },
    COMMENTS_R0005: {
      why: "A comment needs some text.",
      fix: "Write at least one character before you send.",
    },
  },
})
