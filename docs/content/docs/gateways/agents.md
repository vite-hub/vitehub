---
title: Use AI Gateways with Agents
description: Route Codex and Claude Code model requests through a gateway, give an AI SDK model Driver a gateway model, and answer ask Drivers.
navigation.title: Use with Agents
navigation.order: 8
icon: i-lucide-bot
---

An Agent uses a gateway in three ways: a provider Driver sends its model requests through it, an AI SDK model Driver takes a model from it, and an ask Driver asks it typed questions.

## Route provider Drivers

Set `driver.gateway` to route a provider Driver's model requests:

```ts [server/agents/review/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { cliproxy } from 'vite-hub/gateways'

export default defineAgent({
  driver: codexDriver({ model: 'gpt-5.5', gateway: cliproxy() }),
})
```

[Route model requests through a gateway](/docs/agents/agent-drivers#route-model-requests-through-a-gateway) explains how ViteHub configures Codex and Claude Code for a gateway.

## Give a model Driver a gateway model

An AI SDK model Driver can take its model from `languageModel()`, so requests use your gateway instead of the Vercel AI Gateway:

```ts [server/agents/support/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { openrouter } from 'vite-hub/gateways'
import { languageModel } from 'vite-hub/gateways/ai-sdk'

export default defineAgent({
  driver: { model: languageModel(openrouter(), 'google/gemini-3-flash') },
})
```

For the ChatGPT plan, set `driver: { model, gateway: chatgpt() }`. See [ChatGPT plan usage](/docs/connections/chatgpt#use-a-model-backed-driver).

## Answer ask Drivers

An [ask Driver](/docs/agents/agent-drivers#use-an-ask-driver) takes a gateway with `ask()`, or uses `typesafe()`:

```ts [server/agents/labeller.ts]
import { defineAgent } from 'vite-hub/agent'
import { ask, cloudflare } from 'vite-hub/gateways'

export default defineAgent({
  driver: {
    ask: { spam: ask.if('Is it spam?') },
    gateway: cloudflare(),
  },
})
```

## Server Env

ViteHub declares gateway variables in Server Env for the presets that Agent files import from `vite-hub/gateways`, as `env.server.<preset>.<field>`, such as `env.server.cloudflare.accountId`. A preset reads its own `VITEHUB_<PRESET>_<FIELD>` first, such as `VITEHUB_CLOUDFLARE_TYPESAFE_API_KEY` for the TypeSafe key of `cloudflare()`. The Console shows them, and an [Env provider](/docs/env/server-api#read-external-env-storage) can supply them. They stay optional, so a server that does not use the gateway still starts. For the default `typesafe()` gateway, add `typesafe: typesafeEnv()` from `vite-hub/env` to `env.server`.
