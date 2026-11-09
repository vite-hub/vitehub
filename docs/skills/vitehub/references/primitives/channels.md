# Channels

<!-- Generated from docs/content/docs/channels/index.md. Edit the agent-only block there. -->

Source page: https://vitehub.dev/raw/docs/channels.md

A Channel is one connection to a platform, defined once in `server/channels/<name>.ts` with `defineChannel({ adapter, on })` from `vite-hub/channels`. Use it for both directions: inbound webhooks go to the `on` targets (a handler, a Queue or Workflow through a handler, or a `defineChannelTrigger()`), or to the Agent that lists the Channel in `defineAgent({ channels: ['name'] })`. Outbound messages go through `useChannel(name).send()` from any server code.

Use `stripe()` or `webhook({ signature, secret })` from `vite-hub/channels` for HTTP senders, and `slack()`, `teams()`, `discord()`, `telegram()`, `github()`, or `gmail()` from `vite-hub/agent/channels` for chat, forge, and mail. Inbound Channels need `agent: true` next to `channels: true`. Keep secrets in Server Env and never parse or verify a webhook by hand.

Prove one signed delivery reaching its target, one duplicate that does not run twice, and one outbound send with its receipt.
