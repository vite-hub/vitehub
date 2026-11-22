# @vite-hub/channels decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Channels: never print webhook secrets; mutate config.nitro in place

`validateWebhookVerification`, `Channels config hook` in `packages/channels/src/definition.ts`, `packages/channels/src/vite.ts`.

**Context:** Old configs held secret values; Vite concatenates arrays on merge.

**Decision:** Leave the value out of the error; mutate instead of returning.

**Consequences:** No secret leak; no duplicated handlers.
