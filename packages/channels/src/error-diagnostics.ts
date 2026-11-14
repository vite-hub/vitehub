import { defineErrors } from "@vite-hub/runtime"
import { defineDiagnostics } from "nostics"

// Runtime errors. `send()` returns them as `[error, undefined]`. Each code has a heading on the docs page.
export const channelErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/channels/diagnostics",
  codes: {
    CHANNEL_DEFINITION_FAILED: {
      why: ({ channel }: { channel: string }) => `The Channel Definition "${channel}" is missing or failed to load.`,
      fix: "Add `server/channels/<name>.ts` with a default export from `defineChannel()`. Read `error.cause` for the load error.",
    },
    CHANNEL_INVALID_SEND: {
      why: ({ detail }: { detail: string }) => detail,
      fix: "Pass non-empty text and an options object. Send through a Channel whose adapter has `send`, such as `slack()` or `{ kind, send }`.",
    },
    CHANNEL_TRIGGER_FAILED: {
      why: ({ channel, trigger }: { channel: string, trigger: string }) => `The trigger "${trigger}" of Channel "${channel}" could not start.`,
      fix: "Read `error.cause`. Name a trigger or an `on` handler of the Channel, and call from the persistent server that hosts the Channel, with SQLite or libSQL Agent State and `agent: true`.",
    },
    CHANNEL_SEND_FAILED: {
      why: ({ channel, kind }: { channel: string, kind: string }) => `The "${kind}" adapter of Channel "${channel}" failed to send the message.`,
      fix: "Read `error.cause` for the adapter error. The message can still have reached the recipient, so check before you send it again.",
    },
  },
})


const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const channelsErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/channels/diagnostics",
  codes: {
    CHANNELS_B0001: dynamicError,
    CHANNELS_C0001: dynamicError,
    CHANNELS_C0007: dynamicError,
    CHANNELS_C0008: dynamicError,
    CHANNELS_C0009: dynamicError,
    CHANNELS_C0010: dynamicError,
    CHANNELS_C0011: dynamicError,
    CHANNELS_R0002: dynamicError,
    CHANNELS_R0003: dynamicError,
  },
})
