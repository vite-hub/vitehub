# @vite-hub/channels decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Channels: never print webhook secrets; mutate config.nitro in place

`validateWebhookVerification`, `Channels config hook` in `packages/channels/src/definition.ts`, `packages/channels/src/vite.ts`.

**Context:** Old configs held secret values; Vite concatenates arrays on merge.

**Decision:** Leave the value out of the error; mutate instead of returning.

**Consequences:** No secret leak; no duplicated handlers.

## A Channel send ignores throws that come after the adapter accepted the message

`unlessItThrows`, `logDelivery`, `normalizeSendReceipt`, `channelSendErrorMessage` in `packages/channels/src/client.ts`.

**Context:** An adapter's `send()` can return a proxy or an object with getters that throw, and `console.info` can throw. When `send()` resolved, the message is already delivered. A thrown error would turn that delivery into `CHANNEL_SEND_FAILED`, and the caller would send the message again.

**Decision:** Logging, enumerating the receipt, reading a receipt field, and reading the message ID go through `unlessItThrows`. A field that throws is left out of the receipt, and an error message that throws becomes the uninspectable message.

**Consequences:** Letting these throws escape causes duplicate messages on retry. Only use `unlessItThrows` for reads and logs after delivery, never around `send()` itself.
