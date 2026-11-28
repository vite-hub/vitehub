import { defineErrors } from "@vite-hub/runtime"

export type RealtimeRequestAction = "checkpoint" | "refresh" | "save"

/** The `data` of a `REALTIME_REQUEST_FAILED` error. */
export type RealtimeRequestFailure = {
  /** HTTP status of the server answer, such as `409` when the stored document changed. `undefined` for a network error. */
  status: number | undefined
}

type RealtimeInvalidAccessReason = "auth" | "not-authorize" | "not-public" | "origins-without-identify" | "public-with-rule"

export const realtimeErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/realtime/diagnostics",
  codes: {
    // Client errors.
    REALTIME_DISABLED: {
      why: ({ action }: { action: RealtimeRequestAction }) => `Realtime is disabled, so \`${action}()\` cannot run.`,
      fix: "Set `enabled` to `true` on `useRealtimeTiptap()` before you call the method.",
    },
    REALTIME_DISCONNECTED: {
      why: ({ action }: { action: RealtimeRequestAction }) => `The realtime document disconnected or changed during \`${action}()\`.`,
      fix: "Call the method again after the new document connects. Read `synced` to know when it is ready.",
    },
    REALTIME_INVALID_DOCUMENT: {
      why: ({ action }: { action: RealtimeRequestAction }) => `The room body does not fit the editor schema, so \`${action}()\` did not write it. Writing it would lose content.`,
      fix: "Keep editing until the document fits the editor extensions of the Realtime Definition, then call the method again. The room keeps the edits.",
    },
    REALTIME_INVALID_RESPONSE: {
      why: ({ action }: { action: RealtimeRequestAction }) => `The realtime server answered \`${action}()\` with a response that the client cannot use.`,
      fix: "Use the same `@vite-hub/realtime` version on the client and the server, and build again.",
    },
    REALTIME_MISSING_DOCUMENT: {
      why: ({ action }: { action: RealtimeRequestAction }) => `\`${action}()\` needs a document, and \`documentId\` is empty.`,
      fix: "Pass a document path to `useRealtimeTiptap(definition, documentId)` before you call the method.",
    },
    REALTIME_READ_ONLY: {
      why: ({ action }: { action: RealtimeRequestAction }) => `The room is read-only, so \`${action}()\` cannot write the document.`,
      fix: "Read `readOnlyReason` of `useRealtimeTiptap()` for the reason. Do not offer save or publish while it is set.",
    },
    REALTIME_REQUEST_FAILED: {
      why: ({ action, message, status }: { action: RealtimeRequestAction, message?: string, status?: number }) =>
        `The realtime \`${action}()\` request failed${status === undefined ? "" : ` with HTTP ${status}`}${message ? `: ${message}` : "."}`,
      fix: "Read `error.why` for the server message, `error.data.status` for the HTTP status, and `error.cause` for a network error. Retry when the server is available again.",
      data: ({ status }: { action: RealtimeRequestAction, message?: string, status?: number }): RealtimeRequestFailure => ({ status }),
    },
    REALTIME_SOURCE_CHANGED: {
      why: ({ action }: { action: RealtimeRequestAction }) => `The server refused \`${action}()\` because the stored document changed outside the room.`,
      fix: "Tell the person that the stored document changed. Use `onReset()` to detect a room reset and read unsaved edits from the event's `previous` document.",
    },
    REALTIME_SYNC_PENDING: {
      why: ({ action }: { action: RealtimeRequestAction }) => `The room did not receive every edit of this client in time, so \`${action}()\` did not run. The composable tried 20 times.`,
      fix: "Call the method again when `synced` is true. When it keeps failing, check that the WebSocket stays connected.",
    },

    // Room request errors.
    REALTIME_ROOM_ABORTED: {
      why: "The request to the room stopped because its signal aborted.",
      fix: "Nothing to fix when the caller stopped on purpose, such as a cancelled Agent run. Call again to ask once more.",
    },
    REALTIME_ROOM_CROWDED: {
      why: ({ count }: { count: number }) => `${count} browsers are in the room, and a request goes to one browser only.`,
      fix: "Give each browser its own room, such as a random id for each tab, so that one browser answers.",
    },
    REALTIME_ROOM_ELSEWHERE: {
      why: "No browser in this instance is in the room. With Redis or Postgres, the browser can be connected to another instance, and requests reach only the browsers of the same instance.",
      fix: "Route the browser and the caller to the same instance, such as with sticky sessions, or run one Node instance.",
    },
    REALTIME_ROOM_EMPTY: {
      why: "No browser is in the room. The page is closed, or it has not joined yet.",
      fix: "Open the page again. The request waits a few seconds for a browser to join before it gives up.",
    },
    REALTIME_ROOM_REFUSED: {
      why: ({ reason }: { reason: string }) => `The browser could not answer: ${reason}`,
      fix: "Read the reason. Add `room.onRequest(handler)` on the page, and keep each answer under 1 MiB.",
    },
    REALTIME_ROOM_REQUESTS_OFF: {
      why: ({ definition }: { definition: string }) => `The Realtime Definition "${definition}" does not take requests.`,
      fix: "Define it with `defineRealtime({ access: \"public\", document: false, requests: true })`.",
    },
    REALTIME_ROOM_TIMEOUT: {
      why: ({ timeout }: { timeout: number }) => `The browser did not answer in ${timeout / 1000} seconds.`,
      fix: "Make the page answer sooner, or pass a longer `timeout` to `requestRealtimeRoom()`.",
    },

    // Room errors.
    REALTIME_AWARENESS_OWNERSHIP_CONFLICT: {
      why: "A realtime awareness client id belongs to another peer.",
      fix: "Let each editor tab use its own Yjs awareness client. Do not reuse a client id on two connections.",
    },
    REALTIME_AWARENESS_TOO_LARGE: {
      why: "Realtime awareness state exceeds the 8 MiB room quota.",
      fix: "Keep less data in awareness state. Store large values in the document or in Workspace.",
    },
    REALTIME_DOCUMENT_TOO_LARGE: {
      why: "The realtime document exceeds the 8 MiB room quota.",
      fix: "Split the document into smaller documents, or keep large assets in Workspace or Blob.",
    },
    REALTIME_INVALID_AWARENESS: {
      why: "A realtime awareness update has a state that is not a plain object.",
      fix: "Set awareness state to a plain object, for example `awareness.setLocalStateField('user', { name })`.",
    },
    REALTIME_TOO_MANY_AWARENESS_CLIENTS: {
      why: "One realtime peer sent more than 1,024 awareness clients.",
      fix: "Use one awareness client for each editor tab.",
    },

    // Room write errors.
    REALTIME_ROOM_WRITE_CONFLICT: {
      why: "Realtime room record compare-and-set failed.",
      fix: "Connect again. Another Realtime instance changed the room at the same time. If it keeps failing, check that every instance uses the same Realtime bus.",
    },
    REALTIME_WRITE_REJECTED: {
      why: ({ problem, readOnly }: { problem: "missing-state" | "read-only" | "status", readOnly?: string }) => problem === "missing-state"
        ? "Realtime update depends on state this room does not have."
        : problem === "status"
          ? "Realtime document status is written by the server."
          : readOnly ?? "This realtime connection is read-only.",
      fix: "Write only through a writable connection, and do not change the `status` map, which the server writes. A client that misses room state connects again to sync it.",
    },

    // Adapter errors.
    REALTIME_DOCUMENT_CONFLICT: {
      why: ({ problem }: { problem?: string }) => problem ?? "The stored document changed since the realtime room loaded it.",
      fix: "Realtime re-seeds the room from the stored document. Listen to `onReset()` to recover text that the room did not save.",
    },

    // Config errors.
    REALTIME_BLOB_ETAG_MISSING: {
      why: ({ pathname }: { pathname: string }) => `The Blob store returned no \`httpEtag\` for ${pathname}, so \`blobDocument()\` cannot save the file only if it is unchanged.`,
      fix: "Pass a ViteHub Blob store, such as `blob` from `vite-hub/blob`, whose `head()` returns `httpEtag` on every driver. A store of your own must return `httpEtag` from `head()` and accept `ifMatch` in `put()`.",
    },
    REALTIME_INVALID_PERSISTENCE: {
      why: ({ name, reason }: { name: "debounce" | "maxWait", reason: "below-debounce" | "not-milliseconds" }) => reason === "below-debounce"
        ? "Realtime `persistence.maxWait` must be at least `persistence.debounce`."
        : `Realtime \`persistence.${name}\` must be a non-negative number of milliseconds.`,
      fix: "Set `persistence: { debounce: 2_000, maxWait: 10_000 }`, or remove the option to use these defaults.",
    },
    REALTIME_MISSING_ACCESS: {
      why: "The Realtime definition sets no access rule, so it does not say who can read and write its rooms.",
      fix: "Set `authorize: true` to require a signed-in user, set `authorize()` to decide each request, or set `access: \"public\"` to let anyone read and write.",
    },
    REALTIME_INVALID_ACCESS: {
      why: ({ reason }: { reason: RealtimeInvalidAccessReason }) => reason === "auth"
        ? "The Realtime definition sets `auth`. Realtime replaced it with `authorize: true`, and an `authorize()` callback now also runs for signed-out callers."
        : reason === "public-with-rule"
          ? "The Realtime definition sets `access: \"public\"` together with `authorize`, so its access rule is not clear."
          : reason === "not-public"
            ? "The Realtime definition sets `access` to a value other than \"public\"."
            : reason === "not-authorize"
              ? "The Realtime definition sets `authorize` to a value that is not `true` or a function."
              : "The Realtime definition sets `origins()` with `authorize: true` and no `identify()`. Only the Auth trusted-origin policy can allow a different origin to use the ViteHub Auth session.",
      fix: ({ reason }: { reason: RealtimeInvalidAccessReason }) => reason === "auth"
        ? "Replace `auth: true` with `authorize: true`. With an `authorize()` callback, remove `auth` and return `false` from the callback when `user` is `null`."
        : reason === "origins-without-identify"
          ? "Remove `origins()`, or add `identify()` that reads a credential the page sends on purpose, such as a ticket in `params`."
          : reason === "not-authorize"
            ? "Set `authorize: true` to require a signed-in user, or set `authorize()` to a function that returns `true` to allow."
            : "Use `access: \"public\"` alone for open rooms. To limit access, remove `access` and set `authorize`.",
    },
    REALTIME_CHECKPOINT_UNSUPPORTED: {
      why: "The Realtime definition sets `history.checkpoint`, but its document adapter has no `checkpoint()` method, so `history.checkpoint()` could never run.",
      fix: "Add `checkpoint(context, { digest, message, user })` to the document adapter, use `document: { workspace }`, or remove `history`.",
    },
    REALTIME_INVALID_USER: {
      why: "The realtime identity needs a user `id` that is a non-empty string of at most 256 characters.",
      fix: "Return a user with an `id` from the Auth session or from `authorize()`.",
    },
    REALTIME_MISSING_DIGEST: {
      why: ({ operation }: { operation: "checkpoint" | "save" }) => operation === "save"
        ? "Realtime saves need Workspace file digests, and the Workspace Store did not return one."
        : "Realtime checkpoints need a stored document, and the save returned no digest.",
      fix: "Use a Workspace Store that returns file digests, or return `digest` from the document adapter `save()`.",
    },

    REALTIME_INVALID_POSTGRES_URL: {
      why: "REALTIME_POSTGRES_URL is set, and it is not a `postgres://` or `postgresql://` URL.",
      fix: "Set REALTIME_POSTGRES_URL to a Postgres URL, or remove it so that Realtime uses the connection of the Default Database.",
    },
    REALTIME_MISSING_BUS_CONNECTION: {
      why: ({ driver }: { driver: "postgres" | "redis" }) => driver === "redis"
        ? "Realtime driver \"redis\" shares rooms through Redis, and REDIS_URL and a Redis KV_URL are not set."
        : "Realtime driver \"postgres\" shares rooms through Postgres, and the app has no Postgres Default Database and no REALTIME_POSTGRES_URL.",
      fix: "Set REDIS_URL for Redis. For Postgres, define the Default Database with `dialect: \"postgresql\"`, or set REALTIME_POSTGRES_URL. Or set `realtime.driver` to \"auto\".",
    },
    REALTIME_MISSING_SHARED_BUS: {
      why: "This host runs each request in one of many function instances, so Realtime shares rooms through Redis or Postgres. REDIS_URL, a Redis KV_URL, REALTIME_POSTGRES_URL, and a Postgres Default Database are all missing.",
      fix: "Connect a Redis or Upstash Redis store to the project, which sets REDIS_URL or KV_URL. Or define the Default Database with `dialect: \"postgresql\"`, or set REALTIME_POSTGRES_URL.",
    },
    REALTIME_ROOM_LOCK_TIMEOUT: {
      why: "Realtime waited 30 seconds for the save lock of a room, and another instance still holds it.",
      fix: "Make the document adapter `save()` finish in less than 30 seconds. Realtime tries the save again.",
    },

    // Build errors.
    REALTIME_DRIVER_CONFLICT: {
      why: ({ driver, host }: { driver: "cloudflare" | "memory" | "postgres" | "redis", host: string }) => driver === "memory"
        ? `Realtime driver "memory" is single-process only, and the ${host} host runs more than one process.`
        : driver === "cloudflare"
          ? `Realtime driver "cloudflare" does not work with the ${host} host.`
          : `Realtime driver "${driver}" needs a Node.js server, and the ${host} host does not run one.`,
      fix: "Set `realtime.driver` to \"cloudflare\" with a Cloudflare host. With the Node host, use \"auto\", \"postgres\", \"redis\", or \"memory\". With the Vercel host, use \"auto\", \"postgres\", or \"redis\".",
    },
    REALTIME_MISSING_DRIVER: {
      why: "Realtime production builds need one room driver, and ViteHub cannot select one for this deployment.",
      fix: "Deploy with a Cloudflare host to use Durable Objects, or with the Node or Vercel host to share rooms through Postgres or Redis.",
    },
    REALTIME_RENAMED_AUTHORITY_KEY: {
      why: ({ value }: { value: string }) => `\`realtime.authority\` is ${value}. ViteHub renamed this key to \`driver\`, and it does not read \`authority\`, so Realtime would not use the driver you chose.`,
      fix: ({ value }: { value: string }) => `Set \`realtime: { driver: ${value} }\`, or run \`npx @vite-hub/codemods driver-key\` to rename it in every config file.`,
    },
  },
})
