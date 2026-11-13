---
title: Send your first request through a gateway
description: Send an AI SDK model request through OpenRouter, then ask TypeSafe Jev a typed question.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

An AI gateway is one object that knows where to send AI requests and how to sign them. A preset is a ready-made gateway for one provider, such as `openrouter()`.

In this tutorial, you send a prompt to a model through OpenRouter. Then you ask [TypeSafe Jev](https://typesafe.ai) a typed question.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). Run the commands from the root of the app. You need an [OpenRouter](https://openrouter.ai) API key, and a TypeSafe API key for the last step.

::tutorial-step{title="Install the packages"}
## Install the packages

Install AI Gateways, the AI SDK, and the AI SDK provider package of the model API. OpenRouter serves OpenAI-compatible Chat Completions, so install `@ai-sdk/openai-compatible`:

```bash pm [commands/install]
pnpm add @vite-hub/gateways ai @ai-sdk/openai-compatible
```

A ViteHub app imports the package as `vite-hub/gateways`.

::

::tutorial-step{title="Send a prompt"}
## Send a prompt

Add your key to `.env`:

```sh [.env]
OPENROUTER_API_KEY=...
```

Create `answer.ts`:

```ts [answer.ts]
import { generateText } from 'ai'
import { openrouter } from 'vite-hub/gateways'
import { languageModel } from 'vite-hub/gateways/ai-sdk'

// Reads OPENROUTER_API_KEY when it sends the request.
const model = languageModel(openrouter(), 'google/gemini-3-flash')

const { text } = await generateText({ model, prompt: 'What is a Server Primitive?' })
```

- `languageModel(gateway, modelId)` returns an [AI SDK](https://ai-sdk.dev) model. Use it with `generateText()`, `streamText()`, or any library that takes a model.
- The model ID is the ID that the gateway uses, such as `google/gemini-3-flash` on OpenRouter.
- The gateway reads its URL, key, and headers again for each request, so a rotated key applies at once.

::

::tutorial-step{title="Change the provider"}
## Change the provider

Change the preset, and use a model ID of that provider. For example, `ollama()` with `llama3.3` sends the request to a local Ollama server. The code that uses `model` does not change.

TypeScript accepts only a gateway that serves the model API. `languageModel(typesafe(), ...)` is a type error, because TypeSafe answers questions and serves no model API. [Presets](/docs/gateways/configure#presets) lists what each preset serves.

::

::tutorial-step{title="Ask your first question"}
## Ask your first question

`ask()` needs `advocaat`, the TypeSafe client:

```bash pm [commands/install-advocaat]
pnpm add advocaat
```

Add your TypeSafe key to `.env` as `TYPESAFE_API_KEY=...`.

Create `label.ts`:

```ts [label.ts]
import { ask, typesafe } from 'vite-hub/gateways'

// Reads TYPESAFE_API_KEY.
const gateway = typesafe()

const answers = await gateway.ask('MERCADONA 23.10 -34.90 EUR', {
  category: ask.choice('Which category fits this bank transaction?', {
    groceries: 'Food and household shopping.',
    eatingOut: 'Restaurants and cafes.',
  }),
  recurring: ask.if('Is it a recurring payment?'),
})

answers.category.choice // 'groceries' | 'eatingOut'
answers.category.confidence // 0 to 1
answers.recurring // boolean
```

- The first argument is the state: the text that every question is about.
- TypeScript infers the type of each answer from its question.
- Only `vercel()`, `cloudflare()`, and `typesafe()` have `ask()`. On other presets, `ask()` is a type error.

::

## In production

The preset reads the same variables in production. In an Agent, ViteHub declares them in Server Env, so the Console shows them and an Env provider can supply them. See [Use with Agents](/docs/gateways/agents).

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/gateways/configure"}
Pick a preset, pass keys, and set up Cloudflare AI Gateway.
:::

:::card{title="Server API" icon="i-lucide-code-2" to="/docs/gateways/server-api"}
Read `languageModel()`, `ask()`, `askWithModel()`, and `defineAiGateway()`.
:::

:::card{title="Use with Agents" icon="i-lucide-bot" to="/docs/gateways/agents"}
Route Codex, Claude Code, and ask Drivers through a gateway.
:::
::
