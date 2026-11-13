---
title: AI Gateways server API
description: Use a gateway as an AI SDK model, ask typed questions with ask() or askWithModel(), and define a custom gateway.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

A ViteHub app imports the presets, `ask`, `askWithModel()`, and `defineAiGateway()` from `vite-hub/gateways`, and `languageModel()` from `vite-hub/gateways/ai-sdk`. Other projects import the same names from `@vite-hub/gateways`. The package has no Agent, Vite, or Nitro code, so it also works in a plain Node script, a Worker, or another framework.

## Use a model with the AI SDK

`languageModel(gateway, modelId, options?)` returns an [AI SDK](https://ai-sdk.dev) model that sends its requests through the gateway:

```ts [answer.ts]
import { generateText } from 'ai'
import { openrouter } from 'vite-hub/gateways'
import { languageModel } from 'vite-hub/gateways/ai-sdk'

// Reads OPENROUTER_API_KEY when it sends the request.
const model = languageModel(openrouter(), 'google/gemini-3-flash')

const { text } = await generateText({ model, prompt: 'What is a Server Primitive?' })
```

It needs the AI SDK provider package of its model API. The `api` option selects the model API, and its type accepts only APIs that the gateway serves:

| `api` | Request | URL | Package |
| --- | --- | --- | --- |
| `'chat'` | OpenAI Chat Completions | `openai-compatible` | `@ai-sdk/openai-compatible` |
| `'responses'` | OpenAI Responses | `openai-compatible`, else `codex` | `@ai-sdk/openai` |
| `'messages'` | Anthropic Messages | `claude-code` | `@ai-sdk/anthropic` |

The default `api` is `'chat'` with an `openai-compatible` URL, else `'messages'` with a `claude-code` URL, else `'responses'`. So `anthropic()` uses Anthropic Messages, and `openai()` uses Chat Completions until you pass `api: 'responses'`, which OpenAI reasoning models that call tools need.

- The gateway rereads its URL, key, and headers per request, so a rotated key applies at once.
- `languageModel()` reads `process.env`, like a direct `ask()` call. Pass `fetch` for a custom implementation.
- Put `providerOptions` under the name the API reads: the gateway name for `'chat'` (such as `{ openrouter: { ... } }`), `openai` for `'responses'`, and `anthropic` for `'messages'`.

## Ask questions

`gateway.ask(state, questions, options?)` sends typed questions to [TypeSafe Jev](https://typesafe.ai). Only `vercel()`, `typesafe()`, and `cloudflare()` have it. It needs `advocaat`, the TypeSafe client:

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

The answer types come from the questions:

| Builder | Answer |
| --- | --- |
| `ask.choice(instructions, criteria)` | `{ choice, confidence, probabilities }`. `criteria` maps labels to descriptions, or is a list of 2 to 255 labels. |
| `ask.switch(instructions, criteria)` | The selected label only. |
| `ask.score(instructions, levels)` | `{ score, ratio, confidence, legend, probabilities }` for 2 to 10 ordered levels. |
| `ask.chance(instructions, criteria?)` | `{ chance }`, the probability of yes. |
| `ask.if(instructions, { threshold? })` | `true` when the probability of yes is above `threshold`, between `0` and `1`. The default is `0.5`. |
| `ask.each(items, { key, question })` | One question for each item, under the key that `key(item)` returns. |

`options` takes `signal` to cancel the requests, and `onUsage`, which gets the `model`, `provider`, and token `usage` of each request. [Limits](/docs/gateways/limits-and-errors#limits) gives the size limit and the retries.

### Ask with any model

`askWithModel(model)` answers the same questions with any [AI SDK](https://ai-sdk.dev) model, in one structured output request. Use it where a gateway with `ask()` goes. It needs the `ai` package:

```ts [label.ts]
import { ask, askWithModel } from 'vite-hub/gateways'
import { openai } from '@ai-sdk/openai'

const answers = await askWithModel(openai('gpt-5.1-mini')).ask('MERCADONA 23.10 -34.90 EUR', {
  category: ask.choice('Which category fits this bank transaction?', ['groceries', 'eatingOut']),
})
```

A chat model gives one answer and how sure it is. `probabilities` put that number on the answer and share the rest between the other options. Jev gives a real probability for every option, so prefer it when you compare or rank options.

## Custom gateways

`defineAiGateway()` covers an endpoint without a preset. It routes model requests, has no `ask()`, and its type lists the `baseURL` keys, so Driver and `languageModel()` types accept it only where it fits:

```ts [server/gateways.ts]
import { defineAiGateway } from 'vite-hub/gateways'

// Codex through Cloudflare AI Gateway's OpenAI endpoint.
export const codexThroughCloudflare = defineAiGateway({
  name: 'cloudflare-openai',
  baseURL: {
    codex: () => `https://gateway.ai.cloudflare.com/v1/${process.env.CLOUDFLARE_ACCOUNT_ID}/${process.env.CLOUDFLARE_AI_GATEWAY_ID}/openai`,
  },
  apiKeyEnv: ['OPENAI_API_KEY'],
  headers: { 'cf-aig-authorization': () => `Bearer ${process.env.CLOUDFLARE_AI_GATEWAY_TOKEN}` },
})
```

| Option | Description |
| --- | --- |
| `name` | Shown in inspection and diagnostics. |
| `baseURL` | One URL per model API: `codex` (OpenAI Responses at `<url>/responses`, for the Codex Driver), `claude-code` (Anthropic Messages at `<url>/v1/messages`, for the Claude Code Driver and `api: 'messages'`), and `openai-compatible` (Chat Completions at `<url>/chat/completions` and Responses at `<url>/responses`, for AI SDK models). A function runs per request. |
| `apiKey` | A string, a sealed value, or a function. |
| `apiKeyEnv` | Host variables that supply the key, in order. |
| `auth` | `'bearer'` (default) sends `Authorization: Bearer <key>`. `'x-api-key'` sends `x-api-key: <key>`. |
| `headers` | Extra headers. Each value is a secret, like `apiKey`. |

## Other exports

| Export | Description |
| --- | --- |
| `cloudflareAccess()` | Headers for a gateway behind Cloudflare Access. See [Presets](/docs/gateways/configure#presets). |
| `aiGatewayEnv` | The variables that each preset reads. |
| `chatgpt({ connection? })` | A gateway without a key for a Codex Driver or a model-backed Driver. It uses the `chatgpt` Connection by default. See [ChatGPT plan usage](/docs/connections/chatgpt). |
