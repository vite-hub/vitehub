---
title: Send your first request through a gateway
description: Send an AI SDK model request through OpenRouter, get typed data from one call, then ask TypeSafe Jev a typed question.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

An AI gateway defines where model requests go and how to sign them. A preset like `openrouter()` gives you a ready-made gateway for one provider.

In this tutorial, you send a prompt to a model through OpenRouter and get typed data back. Then you ask [TypeSafe Jev](https://typesafe.ai) a typed question.

> [!NOTE] Before you start
> Start with the app from [Installation](/docs/getting-started/installation) and run commands from the app root. You need an [OpenRouter](https://openrouter.ai) API key, plus a TypeSafe API key for the last step.

::tutorial-step{title="Install the packages"}
## Install the packages

Install AI Gateways, the AI SDK, and the AI SDK provider package for the model API. OpenRouter serves OpenAI-compatible Chat Completions, so install `@ai-sdk/openai-compatible`:

```bash pm [commands/install]
pnpm add @vite-hub/gateways ai @ai-sdk/openai-compatible
```

ViteHub apps import the package from `vite-hub/gateways`.

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
const model = languageModel(openrouter(), 'google/gemini-3.8-flash')

const { text } = await generateText({ model, prompt: 'What is a Server Primitive?' })
```

- `languageModel(gateway, modelId)` returns an [AI SDK](https://ai-sdk.dev) model for `generateText()`, `streamText()`, or any library that takes a model.
- Pass the model ID that the gateway expects, such as `google/gemini-3.8-flash` on OpenRouter.
- The gateway reads its URL, key, and headers on each request, so rotated keys apply at once.

::

::tutorial-step{title="Change the provider"}
## Change the provider

To switch providers, change the preset and use a model ID of that provider. For example, `ollama()` with `llama3.3` sends the request to a local Ollama server. The code that uses `model` does not change.

TypeScript accepts only gateways that serve the model API. `languageModel(typesafe(), ...)` is a type error because TypeSafe answers questions instead of serving a model API. [Presets](/docs/gateways/configure#presets) lists what each preset serves.

::

::tutorial-step{title="Get typed data from one call"}
## Get typed data from one call

Call `ask(prompt, { model, schema })` when you need data in a fixed shape, like fields from a receipt. It sends one request and checks the answer against your schema. You do not need an Agent for this.

Create `receipt.ts`:

```ts [receipt.ts]
import { z } from 'zod'
import { ask, openrouter } from 'vite-hub/gateways'
import { languageModel } from 'vite-hub/gateways/ai-sdk'

const [error, receipt] = await ask('MERCADONA 23.10 -34.90 EUR', {
  model: languageModel(openrouter(), 'google/gemini-3.8-flash'),
  schema: z.object({ merchant: z.string(), amount: z.number(), date: z.string() }),
})
if (error) throw error

receipt.merchant // string
```

- `schema` takes any [Standard Schema](https://standardschema.dev) that converts to JSON Schema, such as Zod 4 or ArkType. For Valibot, wrap it with `toStandardJsonSchema()` from `@valibot/to-json-schema`.
- `ask()` returns `[error, data]`. `error` is set when the request fails or when the answer does not match the schema.
- Leave out `schema` to get the answer as text.
- Use an Agent when the model must call tools, keep a conversation, or run for a long time.

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

const [error, answers] = await gateway.ask('MERCADONA 23.10 -34.90 EUR', {
  category: ask.choice('Which category fits this bank transaction?', {
    groceries: 'Food and household shopping.',
    eatingOut: 'Restaurants and cafes.',
  }),
  recurring: ask.if('Is it a recurring payment?'),
})
if (error) throw error

answers.category.choice // 'groceries' | 'eatingOut'
answers.category.confidence // 0 to 1
answers.recurring // boolean
```

- The first argument is the state: the text that every question is about.
- TypeScript infers each answer's type from its question.
- Only `vercel()`, `cloudflare()`, and `typesafe()` have `ask()`. On other presets, `ask()` is a type error.

::

## In production

Presets read the same variables in production. In an Agent, ViteHub declares them in Server Env, so the Console shows them and an Env provider can supply them. See [Use with Agents](/docs/gateways/agents).

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/gateways/configure"}
Pick a preset, pass keys, and set up Cloudflare AI Gateway.
:::

:::card{title="Server API" icon="i-lucide-code-2" to="/docs/gateways/server-api"}
Read `languageModel()`, `ask()`, `gateway.ask()`, `askWithModel()`, and `defineAiGateway()`.
:::

:::card{title="Use with Agents" icon="i-lucide-bot" to="/docs/gateways/agents"}
Route Codex, Claude Code, and ask Drivers through a gateway.
:::
::
