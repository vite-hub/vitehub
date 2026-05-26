---
title: Agent troubleshooting
description: Fix discovery, route, model, and Chat handoff issues.
navigation.title: Troubleshooting
navigation.order: 4
icon: i-lucide-circle-alert
frameworks: [vite, nitro]
---

Use this page when an agent cannot be discovered or called.

## Unknown agent

Cause: the generated registry does not contain the requested name.

Fix: check the file path.

```txt
server/agents/triager.ts -> triager
server/agents/support/reviewer.ts -> support/reviewer
server/agents/docs/config.ts -> docs
```

## No generated route

Cause: routes are disabled by default.

Fix: enable `route`.

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
hubAgent({ route: true })
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/agent/nitro'],
  agent: { route: true },
})
```
::

## Missing model

Error:

```txt
[vitehub] Agent model is required unless the agent defines a custom run() handler.
```

Fix: pass `model`, or define `run`.

```ts
export default defineAgent({
  async run() {
    return { text: 'ok' }
  },
})
```

## Chat hook conflict

Cause: a chat definition uses both `agent` and `onDirectMessage`.

Fix: choose one owner. Use `agent` for the default handoff, or write `onDirectMessage` when you want to own the full flow.

## Cloudflare native routing fails

Cause: the app uses `@vitehub/agent/cloudflare` without Cloudflare's `agents` runtime package.

Fix: install the Cloudflare package in the app that calls the native router.
