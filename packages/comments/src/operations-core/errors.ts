import { defineDiagnostics } from "nostics"

import { commentsClientCodes } from "../client-diagnostics.ts"

// Each code identifies one failure site. Keep published codes stable.
export const commentsErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/comments/diagnostics",
  codes: {
    ...commentsClientCodes,
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
      why: "server/comments.ts defines no authorize policy, so a production build lets in only people signed in with GitHub who can push to the repository, and people that the Console admits to its Comments section. Other signed-in people, such as users of ViteHub Auth or identify, get nothing.",
      fix: "Pass authorize to defineComments({ authorize }) and return true for the people and Agents that may take the action. See https://vitehub.dev/docs/comments/configure#decide-who-can-comment",
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
      fix: "Sign in, then try again. Without ViteHub Auth or `identify`, sign in with GitHub so comments know who writes.",
    },
    COMMENTS_R0013: {
      why: "The comments request did not get an answer from the server.",
      fix: "Check the connection and the app URL, then try again.",
    },
    COMMENTS_R0014: {
      why: "Comments has no place to store attachments: the app has no Blob store and no storeAttachment hook.",
      fix: "Turn on Blob with vitehub({ blob: true }), or pass storeAttachment to defineComments().",
    },
    COMMENTS_R0016: {
      why: "The thread is resolved, so it takes no new replies.",
      fix: "Reopen the thread first, or pass { allowResolved: true } to comments.reply() when your UI allows replies to resolved threads.",
    },
    COMMENTS_R0017: {
      why: ({ message }: { message: string }) => message,
      fix: "Attach an image, a PDF, or a text file of at most 5 MB.",
    },
    COMMENTS_R0018: {
      why: ({ message }: { message: string }) => message,
      fix: "Check the input against the limits of comments: https://vitehub.dev/docs/comments/limits-and-errors",
    },
    COMMENTS_R0019: {
      why: ({ state, missing }: { state: "empty" | "live" | "outdated", missing: readonly string[] }) => state === "live"
        ? "The Database still has the comment tables of the live-site model (vitehub_comment_threads with number, page, and created_by), so Comments cannot read or write threads."
        : state === "outdated"
          ? `The vitehub_comment_threads table misses columns of this version: ${missing.join(", ")}.`
          : "The Database has no comment tables.",
      fix: ({ state }: { state: "empty" | "live" | "outdated" }) => state === "live"
        ? "Move the tables once in a custom migration: run vitehub database generate --custom --schema-snapshot --name comments_one_model, put the SQL of commentsMigrationSql({ from: \"live\" }) from vite-hub/comments/database in it, then run vitehub database migrate. See https://vitehub.dev/docs/comments/configure#upgrade-to-one-model"
        : "Run vitehub database generate and vitehub database migrate, so the Database gets the comment tables of this version. See https://vitehub.dev/docs/comments/configure#upgrade-to-one-model",
    },
    COMMENTS_R0020: {
      why: ({ key }: { key: string }) => `No comment that you may read has the attachment ${JSON.stringify(key)}, or its file is gone.`,
      fix: "Read the attachment through a message that lists its key, as a person who may read that thread.",
    },
    COMMENTS_R0021: {
      why: "Comments stores attachments with storeAttachment, but has no readAttachment to read them back.",
      fix: "Pass readAttachment to defineComments(), next to storeAttachment, and return the file of the key as a Blob.",
    },
    COMMENTS_R0022: {
      why: "Another comment thread of this scope already uses this requestId: it has another author or another subject, or you may not read it.",
      fix: "Send a new requestId, such as crypto.randomUUID(), for each new comment. Send the same requestId again only to retry the same comment.",
    },
    COMMENTS_B0001: {
      why: ({ file }: { file: string }) => `${file} needs a Database, but the Database is off for this app.`,
      fix: "Remove `database: false` from vitehub(), or set `database: true`. vitehub() turns the Database on for comments when the option is unset.",
    },
    COMMENTS_B0002: {
      why: ({ file }: { file: string }) => `${file} must export defineComments(), as \`comments\` or as the default export.`,
      fix: "Write `export default defineComments({ authorize })` in server/comments.ts.",
    },
    COMMENTS_B0003: {
      why: "comments() from @vite-hub/comments/vite is for apps without vitehub(). In this app vitehub() owns the Comments configuration.",
      fix: "Remove comments() from the plugins and set vitehub({ comments: true }), or add server/comments.ts. See https://vitehub.dev/docs/comments/configure#turn-comments-on-in-a-vitehub-app",
    },
  },
})
