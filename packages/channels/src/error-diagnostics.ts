import { defineErrors } from "@vite-hub/runtime"
import { defineDiagnostics } from "nostics"

// Runtime errors. `send()` returns them as `[error, undefined]`. Each code has a heading on the docs page.
export const channelErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/channels/diagnostics",
  codes: {
    CHANNEL_DEFINITION_FAILED: {
      why: ({ channel }: { channel: string }) => `The Channel Definition "${channel}" is missing or failed to load.`,
      fix: "Add `server/channels/<name>.ts` with a default export from `defineOutboundChannel()`. Read `error.cause` for the load error.",
    },
    CHANNEL_INVALID_SEND: {
      why: ({ detail }: { detail: string }) => detail,
      fix: "Pass non-empty text and select a connector that the Channel Definition declares, or set `defaultConnector`.",
    },
    CHANNEL_SEND_FAILED: {
      why: ({ channel, connector }: { channel: string, connector: string }) => `Connector "${connector}" of Channel "${channel}" failed to send the message.`,
      fix: "Read `error.cause` for the connector error. The message can still have reached the recipient, so check before you send it again.",
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
    CHANNELS_C0001: dynamicError,
    CHANNELS_C0002: dynamicError,
    CHANNELS_C0003: dynamicError,
    CHANNELS_C0004: dynamicError,
    CHANNELS_C0005: dynamicError,
    CHANNELS_C0006: dynamicError,
    CHANNELS_R0002: dynamicError,
    CHANNELS_R0003: dynamicError,
  },
})
