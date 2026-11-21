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
      why: ({ channel, detail, kind }: { channel: string, detail?: string, kind: string }) => `The "${kind}" adapter of Channel "${channel}" failed to send the message.${detail ? ` ${detail}` : ""}`,
      fix: "Read `error.cause` for the adapter error. Make `send` of a custom adapter resolve to an object, such as `{ id }`. The message can still have reached the recipient, so check before you send it again.",
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
    CHANNELS_C0001: {
      ...dynamicError,
      fix: "Pass an object with an `adapter` to `defineChannel()`, such as `export default defineChannel({ adapter: stripe() })` in server/channels/<name>.ts.",
    },
    CHANNELS_C0007: {
      ...dynamicError,
      fix: "Give `defineChannel({ adapter })` an adapter with a non-empty `kind`: `stripe()`, `webhook()`, or `slack()` from `vite-hub/channels/adapters`, or your own `{ kind, send }`.",
    },
    CHANNELS_C0008: {
      ...dynamicError,
      fix: "Make `send` of the adapter in `defineChannel({ adapter })` a function, or remove `send` from the adapter.",
    },
    CHANNELS_C0009: {
      ...dynamicError,
      fix: "Pass `defineChannel({ on })` an object that maps each non-empty event name to a function or to a trigger from `defineChannelTrigger()`.",
    },
    CHANNELS_C0010: {
      ...dynamicError,
      fix: "Use `webhook()` or `stripe()` as the adapter of a Channel with `on` handlers, or make the target a trigger from `defineChannelTrigger()`.",
    },
    CHANNELS_C0011: {
      ...dynamicError,
      fix: "Set both `signature` and `secret` in `webhook()`. `secret` names the server variable that holds the secret, such as `webhook({ signature: 'github', secret: 'PREFECT_WEBHOOK_SECRET' })`, or is a function that returns it. `signature` is `'bearer'`, `'token'` with a `header`, `'github'`, `'stripe'`, `{ type: 'hmac-sha256' }`, `{ type: 'stripe', tolerance: '5m' }`, or `{ verify }`. To accept unsigned requests, set `secret: false` and no `signature`.",
    },
    CHANNELS_R0002: {
      ...dynamicError,
      fix: "Add a Channel Definition in `server/channels/<name>.ts` whose file name is the name that the message names, or pass the name of an existing Channel to `useChannel()`.",
    },
    CHANNELS_R0003: {
      ...dynamicError,
      fix: "Pass a nonempty Channel name to `useChannel()`, such as `useChannel(\"alerts\")`.",
    },
    CHANNELS_WEBHOOK_HOST_OFF: {
      why: ({ channel }: { channel: string }) => `[vitehub] The Channel "${channel}" receives webhooks, and the Agent package that serves them is off.`,
      fix: "Remove `agent: false` from `vitehub()`: a Channel file that receives webhooks turns the webhook host on. Outside `vitehub()`, add `hubAgent()` from `@vite-hub/agent/vite` next to `hubChannels()`.",
    },
  },
})
