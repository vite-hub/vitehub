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
    COMMENTS_R0006: {
      why: "server/comments.ts defines no authorize policy, so nobody can read or write comments.",
      fix: "Pass authorize to defineComments({ authorize }) and return true for the people and Agents that may take the action.",
    },
    COMMENTS_R0007: {
      why: ({ message }: { message: string }) => message,
      fix: "Mention only people that users() finds, and write @ and their name in the text.",
    },
    COMMENTS_R0008: {
      why: ({ kind }: { kind: string }) => `The comment subject kind "${kind}" is not defined.`,
      fix: "Use page or content, or add defineCommentSubject({ kind, scope }) to defineComments({ subjects }).",
    },
    COMMENTS_R0009: {
      why: ({ action }: { action: string }) => `This user or Agent may not ${action} this comment.`,
      fix: "Ask for access, or allow the action in defineComments({ authorize }).",
    },
    COMMENTS_R0010: {
      why: "The comments runtime is not installed.",
      fix: "Add server/comments.ts and enable the Database with vitehub({ database: true }). `vite dev` and builds install the runtime for you.",
    },
    COMMENTS_R0011: {
      why: "The comment numbers of this scope are busy.",
      fix: "Try again. Several people created a comment at the same moment.",
    },
    COMMENTS_R0012: {
      why: "Writing a comment needs a signed-in user.",
      fix: "Sign in, then try again. In `vite dev` without sign-in, set console.auth so comments know who writes.",
    },
    COMMENTS_R0013: {
      why: "The comments request did not get an answer from the server.",
      fix: "Check the connection and the app URL, then try again.",
    },
    COMMENTS_B0001: {
      why: ({ file }: { file: string }) => `${file} needs a Database, but the Database is off for this app.`,
      fix: "Remove `database: false` from vitehub(), or set `database: true`. vitehub() turns the Database on for comments when the option is unset.",
    },
    COMMENTS_B0002: {
      why: ({ file }: { file: string }) => `${file} must default-export defineComments().`,
      fix: "Write `export default defineComments({ authorize })` in server/comments.ts.",
    },
  },
})
