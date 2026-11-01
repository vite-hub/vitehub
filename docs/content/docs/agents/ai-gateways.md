---
title: AI gateways
description: One object for where AI requests go. It routes Codex, Claude Code, and AI SDK model requests and answers typed TypeSafe Jev questions.
navigation.order: 13
navigation.group: Define and run
icon: i-lucide-waypoints
navigation.kind: Guides
---

An AI gateway is one object that knows where AI requests go and how to sign them. A gateway has three capabilities:

- **Driver routes.** A provider Driver sends Codex or Claude Code model requests through the gateway. Set the gateway as `driver.gateway`.
- **AI SDK models.** `languageModel(gateway, modelId)` from `@vite-hub/gateways/ai-sdk` returns an [AI SDK](https://ai-sdk.dev) model for `generateText()`, `streamText()`, or any library that takes one.
- **`ask()`.** The gateway answers typed [TypeSafe Jev](https://typesafe.ai) questions, such as "which category fits this transaction". Only gateways that can reach Jev have `ask()`.

Each preset is one gateway, and its type says what it can do. `@vite-hub/gateways` has no Agent, Vite, or Nitro code, so you can also use it in a plain Node script, a Worker, or another framework.

## Install

In a ViteHub application, import from `vite-hub/gateways`. Elsewhere, install the package. `ask()` also needs `advocaat`, the TypeSafe client:

```sh
pnpm add @vite-hub/gateways advocaat
```

## Use a model with the AI SDK

`languageModel()` needs the AI SDK provider package of its model API. Most gateways use the OpenAI-compatible Chat Completions API:

```sh
pnpm add @vite-hub/gateways ai @ai-sdk/openai-compatible
```

```ts [answer.ts]
import { generateText } from 'ai'
import { openrouter } from '@vite-hub/gateways'
import { languageModel } from '@vite-hub/gateways/ai-sdk'

// Reads OPENROUTER_API_KEY when it sends the request.
const model = languageModel(openrouter(), 'google/gemini-3-flash')

const { text } = await generateText({ model, prompt: 'What is a Server Primitive?' })
```

Change the preset to change the provider. The model ID is the ID that the gateway uses, such as `openai/gpt-5` on OpenRouter or `llama3.3` on Ollama.

The `api` option selects the model API. The type accepts only the APIs that the gateway serves:

| `api` | Request | URL | Package |
| --- | --- | --- | --- |
| `'chat'` | OpenAI Chat Completions | `openai-compatible` | `@ai-sdk/openai-compatible` |
| `'responses'` | OpenAI Responses | `openai-compatible`, else `codex` | `@ai-sdk/openai` |
| `'messages'` | Anthropic Messages | `claude-code` | `@ai-sdk/anthropic` |

The default is `'chat'` when the gateway has an `openai-compatible` URL, else `'messages'`, else `'responses'`. So `anthropic()` uses Anthropic Messages, and `openai()` uses Chat Completions until you pass `api: 'responses'`. Use `'responses'` for OpenAI reasoning models that call tools.

The gateway resolves its URL, key, and headers for each request, so a rotated key applies to the next request. `languageModel()` reads `process.env`, like a direct `ask()` call. Pass `fetch` to use a custom fetch implementation. `providerOptions` for `'chat'` go under the gateway name, such as `{ openrouter: { ... } }`; `'responses'` reads `openai` and `'messages'` reads `anthropic`.

## Ask your first question

```ts [label.ts]
import { ask, typesafe } from '@vite-hub/gateways'

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

The answer types come from the questions. [Use an ask Driver](/docs/agents/agent-drivers#use-an-ask-driver) lists every `ask` builder and its answer.

`gateway.ask(state, questions, { signal, onUsage })` sends the questions in sequential bounded requests. The shared state plus each question must fit below 30,000 bytes. It retries up to two times when the provider answers 408, 429, 500, 502, 503, or 504, or when the network fails. `onUsage` receives the `model`, `provider`, and token `usage` of each request.

## Presets

| Preset | Codex | Claude Code | OpenAI-compatible | `ask()` | Variables |
| --- | --- | --- | --- | --- | --- |
| `vercel()` | `https://ai-gateway.vercel.sh/codex/v1` | `https://ai-gateway.vercel.sh/claude-code` | `https://ai-gateway.vercel.sh/v1` | `typesafe-ai/jev` at `https://ai-gateway.vercel.sh/v4/ai` | `AI_GATEWAY_API_KEY`, then `VERCEL_OIDC_TOKEN` |
| `cloudflare()` | | | `.../<account>/<gateway>/compat` | | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, `CLOUDFLARE_AI_GATEWAY_TOKEN`, `CLOUDFLARE_AI_GATEWAY_API_KEY` (see [Cloudflare AI Gateway](#cloudflare-ai-gateway)) |
| `openrouter()` | `https://openrouter.ai/api/v1` | `https://openrouter.ai/api` | `https://openrouter.ai/api/v1` | | `OPENROUTER_API_KEY` |
| `litellm()` | `<url>/v1` | `<url>` | `<url>/v1` | | `LITELLM_URL`, `LITELLM_API_KEY` |
| `cliproxy()` | `<url>/v1` | `<url>` | `<url>/v1` | | `CLIPROXY_URL`, `CLIPROXY_API_KEY` |
| `ollama()` | `<url>/v1` | `<url>` | `<url>/v1` | | `OLLAMA_URL` (default `http://localhost:11434`), `OLLAMA_API_KEY` (default `ollama`) |
| `openai()` | `https://api.openai.com/v1` | | `https://api.openai.com/v1` | | `OPENAI_API_KEY` |
| `anthropic()` | | `https://api.anthropic.com` | | | `ANTHROPIC_API_KEY` |
| `typesafe()` | | | | `jev-latest` at `https://api.typesafe.ai` | `TYPESAFE_API_KEY`, `TYPESAFE_DEFAULT_MODEL` |
| `cloudflareTypesafe()` | | | | `jev-latest` through a [custom provider](#typesafe-through-cloudflare-ai-gateway) | `TYPESAFE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, `CLOUDFLARE_AI_GATEWAY_TOKEN` (optional), `CLOUDFLARE_AI_GATEWAY_SLUG` (default `typesafe`) |

The type of a preset lists what it serves. `AiGateway<{ routes: "codex" }>` accepts only gateways with a Codex URL, so `driver: { kind: 'codex', gateway: anthropic() }` is a type error, and so is `languageModel(typesafe(), ...)`. `vercel()`, `typesafe()`, and `cloudflareTypesafe()` return `AiGateway<{ ask: true }>`. The other presets have no `ask()`, so `ask()` on them is a type error. CLIProxyAPI, LiteLLM, Ollama, OpenRouter, OpenAI, Anthropic, and the Cloudflare OpenAI-compatible endpoint forward model APIs only, not TypeSafe's `/v1/systemone`.

`cloudflareAccess()` returns the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers for a gateway behind Cloudflare Access, from `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. Pass it as `headers`, for example `cliproxy({ headers: cloudflareAccess() })`.

## Credentials

A preset reads each value that you do not pass when it sends a request. Direct `gateway.ask()` calls, including imports from `vite-hub/gateways`, read `process.env`: `VITEHUB_<PRESET>_<FIELD>` first, such as `VITEHUB_TYPESAFE_API_KEY`, then the vendor variable in the table. Provider Drivers, ask Drivers, `llmGate()`, and `llmRoute()` supply [Server Env](/docs/env/configure), with the Cloudflare bindings of the request. `languageModel()` reads `process.env`, also in an AI SDK model Driver. For a direct call with provider-backed Server Env or request bindings, load the values in your application and pass them to the preset.

Vercel keeps its credentials in separate Server Env fields: `vercel.apiKey` reads `AI_GATEWAY_API_KEY`, and `vercel.oidcToken` reads `VERCEL_OIDC_TOKEN`. The API key takes precedence; a token uses OIDC authentication even when an Env provider supplies it.

A value that you pass replaces its variable. Pass the values when the application stores the credentials, for example one key for each tenant:

```ts
import { cloudflare, cloudflareTypesafe, typesafe, vercel } from '@vite-hub/gateways'

typesafe({ apiKey: tenant.typesafeKey })
vercel({ apiKey: tenant.aiGatewayKey })
cloudflare({ accountId, gatewayId, token: tenant.gatewayToken })
cloudflareTypesafe({ apiKey: tenant.typesafeKey, accountId, gatewayId, token, slug })
```

An `apiKey` or header value can also be a sealed Server Env value or a function that returns the value for each request. `undefined` fails the request; it does not fall back to the variable. `cloudflare()` is the exception: its provider key is optional, see [Cloudflare AI Gateway](#cloudflare-ai-gateway). `typesafe()`, `vercel()`, and `cloudflareTypesafe()` also take `model` and `fetch` for `ask()`.

## Use with Agents

Set a gateway as `driver.gateway` to route the model requests of a provider Driver:

```ts [server/agents/review/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { cliproxy } from 'vite-hub/gateways'

export default defineAgent({
  driver: { kind: 'codex', model: 'gpt-5.5', gateway: cliproxy() },
})
```

An AI SDK model Driver takes the model from `languageModel()`, so its requests go through the gateway instead of the Vercel AI Gateway:

```ts [server/agents/support/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { openrouter } from 'vite-hub/gateways'
import { languageModel } from 'vite-hub/gateways/ai-sdk'

export default defineAgent({
  driver: { model: languageModel(openrouter(), 'google/gemini-3-flash') },
})
```

An [ask Driver](/docs/agents/agent-drivers#use-an-ask-driver) takes a gateway with `ask()`. Without one, it uses `typesafe()`:

```ts [server/agents/labeller.ts]
import { defineAgent } from 'vite-hub/agent'
import { ask, cloudflareTypesafe } from 'vite-hub/gateways'

export default defineAgent({
  driver: {
    ask: { spam: ask.if('Is it spam?') },
    gateway: cloudflareTypesafe(),
  },
})
```

[`llmGate()`](/docs/agents/capabilities/llm-gate) and [`llmRoute()`](/docs/agents/capabilities/llm-route) take the same `gateway` option for their Jev decisions.

ViteHub finds the presets that Agent files import from `vite-hub/gateways` and declares their variables in Server Env as `env.server.<preset>.<field>`, for example `env.server.cloudflare.accountId`. A preset reads its own `VITEHUB_<PRESET>_<FIELD>` variable first, such as `VITEHUB_CLOUDFLARE_TYPESAFE_API_KEY` for `cloudflareTypesafe()`. The Console shows them, and an [Env provider](/docs/env/server-api#read-external-env-storage) can supply them. The values stay optional, so a server that does not use the gateway still starts. To declare the variables of the default `typesafe()` gateway, add `typesafe: typesafeEnv()` from `vite-hub/env` to `env.server`.

[Route model requests through a gateway](/docs/agents/agent-drivers#route-model-requests-through-a-gateway) explains how ViteHub configures Codex and Claude Code for a gateway.

## Cloudflare AI Gateway

`cloudflare()` sends AI SDK model requests to the [OpenAI-compatible endpoint](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/) of a Cloudflare AI Gateway: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat/chat/completions`. Model IDs are `{provider}/{model}`, such as `openai/gpt-5` or `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`. The gateway logs each request, and its caching and rate limits apply.

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
| Open gateway, provider key in the request | `CLOUDFLARE_AI_GATEWAY_API_KEY` | `Authorization` |
| Authenticated gateway, provider key in the request | Both | Both |

`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_GATEWAY_ID` are always required. A request without a token and without a key fails with `GATEWAYS_R0002` before it is sent.

`cloudflare()` does not route Drivers. Codex and Claude Code need the vendor endpoints of the gateway, such as `.../openai` with an OpenAI key or `.../anthropic` with an Anthropic key in `x-api-key`. The [next section](#custom-gateways) defines a gateway for Codex through Cloudflare.

### TypeSafe through Cloudflare AI Gateway

Cloudflare AI Gateway has no TypeSafe provider. `cloudflareTypesafe()` reaches TypeSafe through a [custom provider](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/) that you create once per Cloudflare account, and answers `ask()`. It does not serve model APIs.

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

`cloudflareTypesafe().ask()` sends `POST https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/custom-<slug>/v1/systemone` with the TypeSafe key as `Authorization` and the gateway token as `cf-aig-authorization`. TypeSafe still bills the requests.

## Custom gateways

Use `defineAiGateway()` for an endpoint without a preset. It routes model requests and has no `ask()`. Its type lists the keys of `baseURL`, so the Driver and `languageModel()` types accept it only where it fits:

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
| `baseURL` | One URL for each model API: `codex` (OpenAI Responses at `<url>/responses`, for the Codex Driver), `claude-code` (Anthropic Messages at `<url>/v1/messages`, for the Claude Code Driver and `api: 'messages'`), and `openai-compatible` (OpenAI Chat Completions at `<url>/chat/completions` and Responses at `<url>/responses`, for AI SDK models). A function runs for each request. |
| `apiKey` | A string, a sealed value, or a function. |
| `apiKeyEnv` | Host variables that supply the key, in order. |
| `auth` | `'bearer'` (default) sends `Authorization: Bearer <key>`. `'x-api-key'` sends `x-api-key: <key>`. |
| `headers` | Extra headers. Each value is a secret, like `apiKey`. |

## Errors

Every error has a `code`, a `why`, and a `fix`. Errors from `ask()` keep the provider error as `cause`.

| Code | When |
| --- | --- |
| `GATEWAYS_R0001` | A gateway definition is not valid, such as an unknown option or a URL that is not http or https. It throws when you call the preset. |
| `GATEWAYS_R0002` | A key is missing or empty. The message names the variable to set, or `apiKey` when you passed it. |
| `GATEWAYS_R0003` | A header value is missing, empty, or has a line break. |
| `GATEWAYS_R0004` | A URL, a Cloudflare account ID, or an AI Gateway ID is missing or not valid, or the gateway does not serve the Driver or model API. |
| `GATEWAYS_R0005` | `ask()` on a gateway that only routes model requests. |
| `GATEWAYS_R0006` | `ask()` without the `advocaat` package. Install it with `pnpm add advocaat`. |
| `GATEWAYS_R0007` | A Jev question that the `ask` builders do not make, or a question that is too large. |
| `GATEWAYS_R0008` | The provider rejected the key with 401 or 403. `status` is 503, and the error has `providerStatus` and `requestId`. The `fix` names the variable to rotate. |
| `GATEWAYS_R0009` | The provider still failed after three attempts. `status` is 502, and the error has `providerStatus` and `requestId`. |
| `GATEWAYS_R0010` | `languageModel()` without the AI SDK provider package of its model API. The message names the package to install. |
