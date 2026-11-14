import { defineErrors } from "@vite-hub/runtime"

const message = ({ message }: { message: string }) => message

// Keep published codes stable. Each code has a page at https://vitehub.dev/docs/sync/diagnostics/<code>.
const syncDocs = "https://vitehub.dev/docs/sync/diagnostics"

/** The docs page of a Sync code, such as a wire code that the client got from the server. */
export function syncDocsPage(code: string): string {
  return `${syncDocs}/${code.toLowerCase()}`
}

export const syncErrors = /*#__PURE__*/ defineErrors({
  docs: syncDocs,
  codes: {
    // Answers on the wire. The client acts on these codes.
    SYNC_UNAUTHORIZED: {
      why: "`where` of this Sync definition refused the caller, and the caller is not signed in.",
      fix: "Sign in, then pull again. To make the table public, return `{}` from `where`.",
    },
    SYNC_FORBIDDEN: {
      why: ({ reason }: { reason: "where" | "write" | "origin" }) => ({
        where: "`where` of this Sync definition refused the signed-in caller.",
        write: "`write` of this Sync definition refused the write.",
        origin: "The push came from another origin. Only pages of the app may write.",
      })[reason],
      fix: ({ reason }: { reason: "where" | "write" | "origin" }) => reason === "origin"
        ? "Send the push from a page of the app. Behind a proxy, forward `X-Forwarded-Proto` and `X-Forwarded-Host`."
        : "Check the `where` and `write` functions of `server/sync/<name>.ts` for this user.",
    },
    SYNC_SCOPE_CHANGED: {
      why: "The writes were made for another account, such as before a sign-in as another user. The server wrote nothing.",
      fix: "Keep the writes for their account and send them when that account signs in again. Call `clearSync()` on sign-out to drop them.",
    },
    SYNC_READ_ONLY: {
      why: "This Sync definition has `write: false`, so the browser cannot change its rows.",
      fix: "Change the rows in server code and call `recordSyncChanges()`, or remove `write: false`.",
    },
    SYNC_INVALID: {
      why: message,
      fix: "Send only the columns of the table, keep the primary key, and fix the problems in `issues`.",
    },
    SYNC_NOT_FOUND: {
      why: message,
      fix: "Pull again. The row was deleted, or it is outside the scope of the caller.",
    },
    SYNC_KEY_EXISTS: {
      why: ({ key }: { key: string }) => `A row with the key ${JSON.stringify(key)} exists already.`,
      fix: "Insert new rows with a new key, such as `crypto.randomUUID()`, and change existing rows with `update`.",
    },
    SYNC_OUT_OF_SCOPE: {
      why: ({ column }: { column: string }) => `The write or the subset sets \`${column}\` to a value that \`where\` does not allow for this caller.`,
      fix: "Leave out the single values of `where` on insert, so the server fills them. For a column with a list in `where`, such as `teamId`, use one of its values.",
    },
    SYNC_ACTION_REFUSED: {
      why: message,
      fix: "Read the message of the action in `server/sync/<name>.ts`, change the arguments, and call the action again.",
    },
    SYNC_TOO_MANY_MUTATIONS: {
      why: ({ count, limit }: { count: number, limit: number }) => `The push has ${count} mutations. One push may have at most ${limit}.`,
      fix: "Send the mutations in chunks of `syncPushLimit`.",
    },
    SYNC_BAD_REQUEST: {
      why: message,
      fix: "Send `GET ?cursor=<n>&scope=<id>` or `POST` with a JSON `SyncPushRequest`, as `@vite-hub/sync/client` does.",
    },

    // Errors that the browser client makes. The server never sends them.
    SYNC_NETWORK: {
      why: "The Sync route could not be reached.",
      fix: "Check the network. The client tries again later, and at once when the network comes back.",
    },
    SYNC_SERVER_ERROR: {
      why: message,
      fix: "Read the server log. The client tries again later.",
    },
    SYNC_BROWSER_ONLY: {
      why: "Sync writes run in the browser only, and this write ran on the server.",
      fix: "Call `insert`, `update`, `delete`, and `retry` from an event handler or after mount.",
    },
    SYNC_STORE_DESTROYED: {
      why: ({ name }: { name: string }) => `The Sync store ${JSON.stringify(name)} was destroyed.`,
      fix: "Do not use a store after `destroy()`. Call `createSync()` or `useSync()` again to get a new one.",
    },
    SYNC_UNKNOWN_FAILURE: {
      why: "This failure is not in the Sync store. It was retried or dismissed before.",
      fix: "Pass a failure from the current `failures` of the store.",
    },

    // Definition and setup errors. They stop the build or the server start, or fail the request with 500.
    SYNC_INVALID_DEFINITION: {
      why: message,
      fix: "Export `defineSync({ table, where })` from `server/sync/<name>.ts`, with a Drizzle table and a `where` function.",
    },
    SYNC_UNSUPPORTED_TABLE: {
      why: message,
      fix: "Use a Drizzle SQLite table (`sqliteTable()`) with one `text()` primary key column, such as `id: text().primaryKey()`. Clients make keys with `crypto.randomUUID()`.",
    },
    SYNC_INVALID_NAME: {
      why: message,
      fix: "Name each file of `server/sync/` with lowercase letters, digits, and dashes, such as `todos.ts`, and define each name once.",
    },
    SYNC_NO_DATABASE: {
      why: message,
      fix: "Keep the Database on: remove `database: false` from `vitehub()`, and use a SQLite Database (libSQL, D1, or the local default). Sync does not support Postgres yet.",
    },
    SYNC_UNKNOWN_NAME: {
      why: ({ name }: { name: string }) => `No Sync definition is named ${JSON.stringify(name)}.`,
      fix: "Use the name of a file in `server/sync/`, such as `todos` for `server/sync/todos.ts`. Run `vitehub sync list` to see the names.",
    },
    SYNC_NOT_INSTALLED: {
      why: "The running app has no Sync definitions.",
      fix: "Add `server/sync/<name>.ts` with `defineSync()`, and call this from the server of that app.",
    },
  },
})
