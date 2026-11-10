---
title: AI gateways
description: One object for where AI requests go. It routes Codex, Claude Code, and AI SDK model requests and answers typed TypeSafe Jev questions.
navigation.order: 13
navigation.group: Define and run
icon: i-lucide-waypoints
navigation.kind: Guides
---

An AI gateway is one object that knows where to send AI requests and how to sign them. Use it three ways:

- **Driver routes:** set it as `driver.gateway`, and a provider Driver (Codex or Claude Code) sends its model requests through it.
- **AI SDK models:** `languageModel(gateway, modelId)` from `vite-hub/gateways/ai-sdk` returns an [AI SDK](https://ai-sdk.dev) model for `generateText()`, `streamText()`, or any library that takes a model.
- **`ask()`:** gateways that reach [TypeSafe Jev](https://typesafe.ai) answer typed questions, such as "which category fits this transaction".

A preset is a ready-made gateway for one provider, such as `openrouter()`, and its type says what it can do. `@vite-hub/gateways` has no Agent, Vite, or Nitro code, so it also works in a plain Node script, a Worker, or another framework.

## Install

ViteHub applications import from `vite-hub/gateways`. Other projects install the package. `ask()` also needs `advocaat`, the TypeSafe client:

```sh
pnpm add @vite-hub/gateways advocaat
```

## Use a model with the AI SDK

`languageModel()` needs the AI SDK provider package of its model API. Most gateways use OpenAI-compatible Chat Completions, so install `@ai-sdk/openai-compatible`:

```sh
pnpm add @vite-hub/gateways ai @ai-sdk/openai-compatible
```

```ts [answer.ts]
import { generateText } from 'ai'
import { openrouter } from 'vite-hub/gateways'
import { languageModel } from 'vite-hub/gateways/ai-sdk'

// Reads OPENROUTER_API_KEY when it sends the request.
const model = languageModel(openrouter(), 'google/gemini-3-flash')

const { text } = await generateText({ model, prompt: 'What is a Server Primitive?' })
```

To change the provider, change the preset and use its model ID, such as `openai/gpt-5` on OpenRouter or `llama3.3` on Ollama. The `api` option selects the model API, and its type accepts only APIs that the gateway serves:

| `api` | Request | URL | Package |
| --- | --- | --- | --- |
| `'chat'` | OpenAI Chat Completions | `openai-compatible` | `@ai-sdk/openai-compatible` |
| `'responses'` | OpenAI Responses | `openai-compatible`, else `codex` | `@ai-sdk/openai` |
| `'messages'` | Anthropic Messages | `claude-code` | `@ai-sdk/anthropic` |

The default `api` is `'chat'` with an `openai-compatible` URL, else `'messages'` with a `claude-code` URL, else `'responses'`. So `anthropic()` uses Anthropic Messages, and `openai()` uses Chat Completions until you pass `api: 'responses'`, which OpenAI reasoning models that call tools need.

- The gateway rereads its URL, key, and headers per request, so a rotated key applies at once.
- `languageModel()` reads `process.env`, like a direct `ask()` call. Pass `fetch` for a custom implementation.
- Put `providerOptions` under the name the API reads: the gateway name for `'chat'` (such as `{ openrouter: { ... } }`), `openai` for `'responses'`, and `anthropic` for `'messages'`.

## Ask your first question

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

TypeScript infers answer types from the questions. [Use an ask Driver](/docs/agents/agent-drivers#use-an-ask-driver) lists every `ask` builder.

`gateway.ask(state, questions, { signal, onUsage })` sends the questions in a sequence of size-limited requests. The shared state plus each question must be under 30,000 bytes. It retries up to two times on network failure or a 408, 429, 500, 502, 503, or 504 answer. `onUsage` gets the `model`, `provider`, and token `usage` of each request.

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

## Presets

| Preset | Codex | Claude Code | OpenAI-compatible | `ask()` | Variables |
| --- | --- | --- | --- | --- | --- |
| `vercel()` | `https://ai-gateway.vercel.sh/codex/v1` | `https://ai-gateway.vercel.sh/claude-code` | `https://ai-gateway.vercel.sh/v1` | `typesafe-ai/jev` at `https://ai-gateway.vercel.sh/v4/ai` | `AI_GATEWAY_API_KEY`, then `VERCEL_OIDC_TOKEN` |
| `cloudflare()` | | | `.../<account>/<gateway>/compat` | `jev-latest` through a [custom provider](#typesafe-through-cloudflare-ai-gateway) | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, `CLOUDFLARE_AI_GATEWAY_TOKEN`, `CLOUDFLARE_AI_GATEWAY_API_KEY`, `TYPESAFE_API_KEY`, `CLOUDFLARE_AI_GATEWAY_SLUG` (see [Cloudflare AI Gateway](#cloudflare-ai-gateway)) |
| `openrouter()` | `https://openrouter.ai/api/v1` | `https://openrouter.ai/api` | `https://openrouter.ai/api/v1` | | `OPENROUTER_API_KEY` |
| `litellm()` | `<url>/v1` | `<url>` | `<url>/v1` | | `LITELLM_URL`, `LITELLM_API_KEY` |
| `cliproxy()` | `<url>/v1` | `<url>` | `<url>/v1` | | `CLIPROXY_URL`, `CLIPROXY_API_KEY` |
| `ollama()` | `<url>/v1` | `<url>` | `<url>/v1` | | `OLLAMA_URL` (default `http://localhost:11434`), `OLLAMA_API_KEY` (default `ollama`) |
| `openai()` | `https://api.openai.com/v1` | | `https://api.openai.com/v1` | | `OPENAI_API_KEY` |
| `anthropic()` | | `https://api.anthropic.com` | | | `ANTHROPIC_API_KEY` |
| `typesafe()` | | | | `jev-latest` at `https://api.typesafe.ai` | `TYPESAFE_API_KEY`, `TYPESAFE_DEFAULT_MODEL` |

Preset types list what they serve, so TypeScript catches a wrong gateway:

- `AiGateway<{ routes: "codex" }>` accepts only gateways with a Codex URL, so `driver: codexDriver({ gateway: anthropic() })` and `languageModel(typesafe(), ...)` are type errors.
- Only `vercel()`, `typesafe()`, and `cloudflare()` return `AiGateway<{ ask: true }>`; `ask()` on others is a type error.
- CLIProxyAPI, LiteLLM, Ollama, OpenRouter, OpenAI, Anthropic, and the Cloudflare OpenAI-compatible endpoint forward only model APIs, not TypeSafe's `/v1/systemone`.

Behind Cloudflare Access, pass `cloudflareAccess()` as `headers`, such as `cliproxy({ headers: cloudflareAccess() })`. It returns `CF-Access-Client-Id` and `CF-Access-Client-Secret` from `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.

## Credentials

A preset reads each value that you did not pass when it sends a request:

- Direct `gateway.ask()` calls, including imports from `vite-hub/gateways`, read `process.env`: `VITEHUB_<PRESET>_<FIELD>` first, such as `VITEHUB_TYPESAFE_API_KEY`, then the vendor variable in the table.
- Provider Drivers, ask Drivers, `llmGate()`, and `llmRoute()` supply [Server Env](/docs/env/configure) with the request's Cloudflare bindings.
- `languageModel()` reads `process.env`, also in an AI SDK model Driver.

For a direct call that needs provider-backed Server Env or request bindings, load the values yourself and pass them.

Vercel uses separate Server Env fields: `vercel.apiKey` reads `AI_GATEWAY_API_KEY` and wins over `vercel.oidcToken`, which reads `VERCEL_OIDC_TOKEN`. A token uses OIDC authentication, even from an Env provider.

A passed value replaces its variable. Pass values when your application stores credentials, such as one key per tenant:

```ts fragment
import { cloudflare, typesafe, vercel } from 'vite-hub/gateways'

typesafe({ apiKey: tenant.typesafeKey })
vercel({ apiKey: tenant.aiGatewayKey })
cloudflare({ accountId, gatewayId, token: tenant.gatewayToken, typesafeApiKey: tenant.typesafeKey, slug })
```

- An `apiKey` or header value can be a sealed Server Env value or a per-request function.
- `undefined` fails the request instead of falling back to the variable.
- `cloudflare()` reads `typesafeApiKey` for `ask()` and an optional `providerApiKey` for models ([Cloudflare AI Gateway](#cloudflare-ai-gateway)).
- `typesafe()`, `vercel()`, and `cloudflare()` also take `model` and `fetch` for `ask()`.

## Use with Agents

Set `driver.gateway` to route a provider Driver's model requests:

```ts [server/agents/review/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { cliproxy } from 'vite-hub/gateways'

export default defineAgent({
  driver: codexDriver({ model: 'gpt-5.5', gateway: cliproxy() }),
})
```

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

[`llmGate()`](/docs/agents/capabilities/llm-gate) and [`llmRoute()`](/docs/agents/capabilities/llm-route) take the same `gateway` option for their Jev decisions.

ViteHub declares gateway variables in Server Env for the presets that Agent files import from `vite-hub/gateways`, as `env.server.<preset>.<field>`, such as `env.server.cloudflare.accountId`. A preset reads its own `VITEHUB_<PRESET>_<FIELD>` first, such as `VITEHUB_CLOUDFLARE_TYPESAFE_API_KEY` for the TypeSafe key of `cloudflare()`. The Console shows them, and an [Env provider](/docs/env/server-api#read-external-env-storage) can supply them. They stay optional, so a server that does not use the gateway still starts. For the default `typesafe()` gateway, add `typesafe: typesafeEnv()` from `vite-hub/env` to `env.server`.

[Route model requests through a gateway](/docs/agents/agent-drivers#route-model-requests-through-a-gateway) explains how ViteHub configures Codex and Claude Code for a gateway.

## Cloudflare AI Gateway

`cloudflare()` sends AI SDK model requests through a Cloudflare AI Gateway, which logs each request and applies its caching and rate limits. It uses the gateway's [OpenAI-compatible endpoint](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/), `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat/chat/completions`, which supports only `api: 'chat'` (ViteHub rejects `api: 'responses'`). Model IDs are `{provider}/{model}`, such as `openai/gpt-5` or `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`.

```ts [server/api/answer.ts]
import { generateText } from 'ai'
import { cloudflare } from 'vite-hub/gateways'
import { languageModel } from 'vite-hub/gateways/ai-sdk'

const model = languageModel(cloudflare(), 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast')
```

Each request needs a gateway token, a provider key, or both:

| Setup | Variables | Headers |
| --- | --- | --- |
| The gateway stores the provider keys, or uses Unified Billing | `CLOUDFLARE_AI_GATEWAY_TOKEN` | `cf-aig-authorization` |
| Open gateway, provider key in the request | `CLOUDFLARE_AI_GATEWAY_API_KEY` (or `providerApiKey`) | `Authorization` |
| Authenticated gateway, provider key in the request | Both | Both |

`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_GATEWAY_ID` are always required. A request with neither token nor provider key fails with `GATEWAYS_R0002` before it is sent. The keys never mix: `ask()` sends only the TypeSafe key, and model requests only the provider key. `cloudflare({ apiKey })` throws with an error that names both options.

`cloudflare()` does not route Drivers. Codex and Claude Code need the gateway's vendor endpoints, such as `.../openai` with an OpenAI key or `.../anthropic` with an Anthropic key in `x-api-key`. [Custom gateways](#custom-gateways) defines one for Codex through Cloudflare.

### TypeSafe through Cloudflare AI Gateway

Cloudflare AI Gateway has no TypeSafe provider, so `cloudflare().ask()` uses a [custom provider](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/) that you create once per Cloudflare account. It reads `TYPESAFE_API_KEY`, or a passed `typesafeApiKey`.

1. In the Cloudflare dashboard, go to **Compute & AI** > **AI Gateway** and create a gateway. Its name is the gateway ID.
2. Go to **Custom Providers** and select **Add Custom Provider**. Set the slug to `typesafe` and the base URL to `https://api.typesafe.ai`. Or use the Cloudflare API:

   ```sh
   curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/custom-providers \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"name":"TypeSafe","slug":"typesafe","base_url":"https://api.typesafe.ai","enable":true}'
   ```

3. If the gateway is authenticated, create a gateway token in the gateway settings.
4. Set the variables:

   ```sh [.env]
   TYPESAFE_API_KEY=...
   CLOUDFLARE_ACCOUNT_ID=...
   CLOUDFLARE_AI_GATEWAY_ID=...
   # Only for an authenticated gateway.
   CLOUDFLARE_AI_GATEWAY_TOKEN=...
   # Only when the custom provider slug is not typesafe.
   CLOUDFLARE_AI_GATEWAY_SLUG=...
   ```

`cloudflare().ask()` sends `POST https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/custom-<slug>/v1/systemone` with the TypeSafe key as `Authorization` and the gateway token as `cf-aig-authorization`. TypeSafe still bills them.

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

## Errors

Every error has a `code`, a `why`, and a `fix`. Errors from `ask()` keep the provider error as `cause`.

| Code | When |
| --- | --- |
| `GATEWAYS_R0001` | Invalid gateway definition, such as an unknown option or a non-http(s) URL. Thrown when you call the preset. |
| `GATEWAYS_R0002` | A key is missing or empty. The message names the variable to set, or `apiKey` when passed. |
| `GATEWAYS_R0003` | A header value is missing, empty, or has a line break. |
| `GATEWAYS_R0004` | A URL, Cloudflare account ID, or AI Gateway ID is missing or invalid, or the gateway does not serve the Driver or model API. |
| `GATEWAYS_R0005` | `ask()` on a gateway that only routes model requests. |
| `GATEWAYS_R0006` | `ask()` without the `advocaat` package. Install it with `pnpm add advocaat`. |
| `GATEWAYS_R0007` | A Jev question that the `ask` builders do not make, or one that is too large. |
| `GATEWAYS_R0008` | The provider rejected the key with 401 or 403. `status` is 503, with `providerStatus` and `requestId`. The `fix` names the variable to rotate. |
| `GATEWAYS_R0009` | The provider still failed after three attempts. `status` is 502, with `providerStatus` and `requestId`. |
| `GATEWAYS_R0010` | `languageModel()` without its model API's AI SDK provider package, which the message names. |
| `GATEWAYS_R0011` | `askWithModel()` without the `ai` package. Install it with `pnpm add ai`. |
| `GATEWAYS_R0012` | The model of `askWithModel()` answered a question with a value that is not one of its options. |
