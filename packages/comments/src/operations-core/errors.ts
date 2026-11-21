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
      why: "Another comment thread of this scope, or another reply in this thread, already uses this requestId: it has another author or another subject, or you may not read it.",
      fix: "Send a new requestId, such as crypto.randomUUID(), for each new comment or reply. Send the same requestId again only to retry the same one.",
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
    COMMENTS_B0004: {
      why: ({ file }: { file: string }) => `The \`database\` option of defineComments() in ${file} is not a string literal. The build reads it without running the file, so Comments would use the default Database.`,
      fix: "Write the Database name as a string literal, such as `defineComments({ database: \"content\" })`, and put no spread after it. Remove the option to use the default or only Database.",
    },
    // Named errors. Keep these codes in alphabetical order.
    COMMENTS_DATABASE_TOKEN_IN_BUILD: {
      why: "The `database` option of `comments()` has an `authToken` in its URL, so the token ends up in the build output.",
      fix: "Put the URL with its token in a variable, and pass the variable: `comments({ database: \"env:COMMENTS_DATABASE_URL\" })`.",
    },
    COMMENTS_GITHUB_CREDENTIALS_MISSING: {
      why: "Comments needs GitHub credentials to post to pull requests: VITEHUB_GITHUB_APP_ID with VITEHUB_GITHUB_PRIVATE_KEY, or VITEHUB_GITHUB_TOKEN.",
      fix: "Set `VITEHUB_GITHUB_APP_ID` and `VITEHUB_GITHUB_PRIVATE_KEY` of a GitHub App that is installed on the repository, or set `VITEHUB_GITHUB_TOKEN`.",
    },
    COMMENTS_GITHUB_REQUEST_FAILED: {
      why: ({ path, status }: { path: string, status: number }) => `GitHub GET ${path} failed with ${status}`,
      fix: "Sign in with GitHub again, because a status of 401 means that the token expired. For other statuses, check that the GitHub OAuth app of the Comments login is active and that GitHub is reachable.",
    },
    COMMENTS_GITHUB_SYNC_FAILED: {
      why: ({ reason, request, status }: { reason: string, request: string, status: number }) => `GitHub ${request} failed with ${status}: ${reason}`,
      fix: "Check that the GitHub App or `VITEHUB_GITHUB_TOKEN` can write pull request comments in the repository. A retry helps for a 5xx status.",
    },
    COMMENTS_GUEST_RATE_LIMITED: {
      why: ({ retryAfter }: { retryAfter: number | undefined }) => `This address sent too many guest comments${retryAfter === undefined ? "" : `. It may write again in ${Math.ceil(retryAfter)} seconds`}.`,
      fix: "Wait, then try again. Sign in to write without the guest limit of defineComments({ rateLimit }).",
    },
    COMMENTS_MIGRATION_DATABASE_UNSUPPORTED: {
      why: ({ dialect }: { dialect: "postgresql" | "sqlite" }) => dialect === "postgresql"
        ? "[vitehub] migrateComments() needs a Postgres Drizzle database with transaction()."
        : "[vitehub] migrateComments() needs a Drizzle database with batch() or transaction(), so a failure changes nothing.",
      fix: "Pass `migrateComments()` the Drizzle database of `useDatabase()`, or of another driver with `transaction()` on Postgres, or `batch()` or `transaction()` on SQLite.",
    },
    COMMENTS_MIGRATION_LIVE_POSTGRES: {
      why: "[vitehub] The live-site comments model had no Postgres tables, so there is nothing to move.",
      fix: "Use `from: \"outdated\"` for a Postgres Database. Only SQLite, libSQL, and D1 have tables of the live-site model.",
    },
    COMMENTS_RATE_LIMIT_INVALID: {
      why: ({ issue }: { issue: string }) => `defineComments(): ${issue}`,
      fix: "Pass rateLimit as { limit, window }, such as { limit: 5, window: \"1m\" }, or remove it to let guests write without a limit.",
    },
    COMMENTS_SECRET_TOO_SHORT: {
      why: ({ minimum }: { minimum: number }) => `[vitehub] VITEHUB_SECRET must be at least ${minimum} characters. Generate one with \`openssl rand -base64 32\`.`,
      fix: "Set `VITEHUB_SECRET` to the output of `openssl rand -base64 32`, which has 44 characters.",
    },
    COMMENTS_SEND_POSTGRES: {
      why: "`defineComments({ send })` keeps its sends in SQLite tables, and this app keeps comments in Postgres.",
      fix: "Keep comments in a SQLite, libSQL, or D1 Database, or remove `send` from `defineComments()`.",
    },
    COMMENTS_SEND_TABLES_MISSING: {
      why: ({ missing }: { missing: string }) => `\`defineComments({ send })\` needs the tables ${missing}, and the Database does not have them yet.`,
      fix: "Run `vitehub database generate` and `vitehub database migrate`. `vite dev` applies the migration for you.",
    },
    COMMENTS_SEND_WEBHOOKS_OFF: {
      why: ({ file }: { file: string }) => `${file} turns on Send, and Send delivers through the member endpoints of Webhooks, which this app does not have.`,
      fix: "Use Comments through `vitehub()`, which adds Webhooks, and install `@vite-hub/webhooks` when you use the packages one by one. `comments()` without `vite-hub` has no Send.",
    },
  },
})
