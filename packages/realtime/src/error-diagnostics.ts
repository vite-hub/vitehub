import { defineErrors } from "@vite-hub/runtime"

export type RealtimeRequestAction = "checkpoint" | "refresh" | "save"

// Keep published codes stable. Each code has a heading on the docs page.
export const realtimeErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/realtime/diagnostics",
  codes: {
    // Client errors. `save()`, `history.checkpoint()`, and `refresh()` return them as `[error, undefined]`.
    REALTIME_DISABLED: {
      why: ({ action }: { action: RealtimeRequestAction }) => `Realtime is disabled, so \`${action}()\` cannot run.`,
      fix: "Set `enabled` to `true` on `useRealtimeTiptap()` before you call the method.",
    },
    REALTIME_DISCONNECTED: {
      why: ({ action }: { action: RealtimeRequestAction }) => `The realtime document disconnected or changed during \`${action}()\`.`,
      fix: "Call the method again after the new document connects. Read `synced` to know when it is ready.",
    },
    REALTIME_INVALID_RESPONSE: {
      why: ({ action }: { action: RealtimeRequestAction }) => `The realtime server answered \`${action}()\` with a response that the client cannot use.`,
      fix: "Use the same `@vite-hub/realtime` version on the client and the server, and build again.",
    },
    REALTIME_MISSING_DOCUMENT: {
      why: ({ action }: { action: RealtimeRequestAction }) => `\`${action}()\` needs a document, and \`documentId\` is empty.`,
      fix: "Pass a document path to `useRealtimeTiptap(definition, documentId)` before you call the method.",
    },
    REALTIME_REQUEST_FAILED: {
      why: ({ action, message, status }: { action: RealtimeRequestAction, message?: string, status?: number }) =>
        `The realtime \`${action}()\` request failed${status === undefined ? "" : ` with HTTP ${status}`}${message ? `: ${message}` : "."}`,
      fix: "Read `error.why` for the server message, and `error.cause` for a network error. Retry when the server is available again.",
    },

    // Room errors. The server closes the WebSocket with a close code, so the client sees them in the stream.
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

    // Adapter errors. A document adapter throws `RealtimeDocumentConflict`, and the room re-seeds.
    REALTIME_DOCUMENT_CONFLICT: {
      why: ({ problem }: { problem?: string }) => problem ?? "The stored document changed since the realtime room loaded it.",
      fix: "Realtime re-seeds the room from the stored document. Listen to `onReset()` to recover text that the room did not save.",
    },

    // Config errors. The server throws them, because the code or the deployment must change.
    REALTIME_INVALID_PERSISTENCE: {
      why: ({ name, reason }: { name: "debounce" | "maxWait", reason: "below-debounce" | "not-milliseconds" }) => reason === "below-debounce"
        ? "Realtime `persistence.maxWait` must be at least `persistence.debounce`."
        : `Realtime \`persistence.${name}\` must be a non-negative number of milliseconds.`,
      fix: "Set `persistence: { debounce: 2_000, maxWait: 10_000 }`, or remove the option to use these defaults.",
    },
    REALTIME_MISSING_ACCESS: {
      why: "The Realtime definition sets no access rule, so it does not say who can read and write its rooms.",
      fix: "Set `auth: true` to require a signed-in user, add `authorize()` to decide each request, or set `access: \"public\"` to let anyone read and write.",
    },
    REALTIME_INVALID_ACCESS: {
      why: ({ reason }: { reason: "public-with-rule" | "not-public" | "origins-without-identify" }) => reason === "public-with-rule"
        ? "The Realtime definition sets `access: \"public\"` together with `auth` or `authorize()`, so its access rule is not clear."
        : reason === "not-public"
          ? "The Realtime definition sets `access` to a value other than \"public\"."
          : "The Realtime definition sets `origins()` with `auth: true` and no `identify()`. The ViteHub Auth session is a cookie, so ViteHub accepts it only from the app's own origin.",
      fix: ({ reason }: { reason: "public-with-rule" | "not-public" | "origins-without-identify" }) => reason === "origins-without-identify"
        ? "Remove `origins()`, or add `identify()` that reads a credential the page sends on purpose, such as a ticket in `params`."
        : "Use `access: \"public\"` alone for open rooms. To limit access, remove `access` and set `auth: true` or `authorize()`.",
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
      why: ({ authority }: { authority: "postgres" | "redis" }) => authority === "redis"
        ? "Realtime authority \"redis\" shares rooms through Redis, and REDIS_URL is not set."
        : "Realtime authority \"postgres\" shares rooms through Postgres, and the app has no Postgres Default Database and no REALTIME_POSTGRES_URL.",
      fix: "Set REDIS_URL for Redis. For Postgres, define the Default Database with `dialect: \"postgresql\"`, or set REALTIME_POSTGRES_URL. Or set `realtime.authority` to \"auto\".",
    },
    REALTIME_ROOM_LOCK_TIMEOUT: {
      why: "Realtime waited 30 seconds for the save lock of a room, and another instance still holds it.",
      fix: "Make the document adapter `save()` finish in less than 30 seconds. Realtime tries the save again.",
    },

    // Build errors. The Vite integration throws them when it reads the config.
    REALTIME_AUTHORITY_CONFLICT: {
      why: ({ authority, host }: { authority: "cloudflare" | "memory" | "postgres" | "redis", host: string }) => authority === "memory"
        ? `Realtime authority "memory" is single-process only, and the ${host} host runs more than one process.`
        : authority === "cloudflare"
          ? `Realtime authority "cloudflare" does not work with the ${host} host.`
          : `Realtime authority "${authority}" needs a Node.js server, and the ${host} host does not run one.`,
      fix: "Set `realtime.authority` to \"cloudflare\" with a Cloudflare host. With the Node host, use \"auto\", \"postgres\", \"redis\", or \"memory\".",
    },
    REALTIME_MISSING_AUTHORITY: {
      why: "Realtime production builds need one room authority, and ViteHub cannot select one for this deployment.",
      fix: "Deploy with a Cloudflare host to use Durable Objects, or with the Node host to share rooms through Postgres or Redis.",
    },
  },
})
