---
title: Chat troubleshooting
description: Fix missing user names, unknown platforms, missing Durable Object bindings, and generated route issues.
navigation.title: Troubleshooting
navigation.order: 100
icon: i-lucide-circle-alert
frameworks: [vite, nitro]
---

Use this page when a Chat definition builds but webhooks do not behave as expected.

## Missing chat user name

Error:

```txt
Missing chat userName. Set userName in defineChat() or place the definition in a discovered chat file such as server/chat.ts.
```

Cause: Chat SDK needs a user name, and ViteHub could not infer one from the discovered file.

Fix: set `userName` in `defineChat()` or move the definition into a discovered file path.

```ts
export default defineChat({
  adapters,
  state,
  userName: 'Support Bot',
})
```

## Unknown chat platform

Response:

```txt
Unknown chat platform: telegram
```

Cause: the route param resolved to `telegram`, but the Chat SDK bot did not register a `telegram` webhook.

Fix: add the adapter and webhook setup for that platform, or send requests to a route that matches an existing platform key.

## Missing Durable Object binding

Error:

```txt
Missing Cloudflare Durable Object binding CHAT_STATE.
```

Cause: `cloudflareDurableObjectState()` is active, but the Worker request did not include the expected Durable Object binding.

Fix: enable generated Cloudflare Durable Object setup or configure the binding manually.

```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/chat/nitro'],
  chat: {
    provider: 'cloudflare',
    cloudflare: {
      durableObjectState: true,
    },
  },
})
```

If you use a custom binding name, pass the same name to both module config and `cloudflareDurableObjectState()`.

## Generated route is missing

Symptom: `/api/webhooks/telegram` returns the app's normal 404 page.

Cause: the Chat module did not discover a chat definition, or generated webhook routes are disabled.

Fix:

1. Confirm the module is registered.
2. Confirm `webhook` is not `false`.
3. Place the definition at `server/chat.ts` or under `server/chats/**`.
4. Restart the dev server so discovery runs again.

## Local dev state resets

Symptom: conversations lose state after a dev server restart.

Cause: the local memory state fallback is for development only.

Fix: use Cloudflare Durable Object state for hosted Cloudflare deployments. Do not rely on local memory state for persistence.

## Runtime config is undefined

Symptom: an adapter resolver throws when reading `runtimeConfig.telegram.botToken`.

Cause: the runtime config key was not added by Nitro, or the generated handler is running outside the configured Nitro app.

Fix: add the config key through Nitro runtime config or `@vitehub/env`, then read it in the resolver.

```ts
export default defineChat({
  adapters({ runtimeConfig }) {
    return {
      telegram: createTelegramAdapter({
        botToken: runtimeConfig.telegram.botToken,
      }),
    }
  },
  state,
  userName: 'Support Bot',
})
```
