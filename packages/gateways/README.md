# @vite-hub/gateways

An AI gateway is one object that knows where AI requests go and how to sign them. A gateway has three capabilities:

- **Driver routes.** It routes Codex and Claude Code model requests, for example through Vercel AI Gateway or CLIProxyAPI.
- **AI SDK models.** `languageModel(gateway, modelId)` from `@vite-hub/gateways/ai-sdk` returns an [AI SDK](https://ai-sdk.dev) model that sends its requests through the gateway.
- **`ask()`.** It answers typed [TypeSafe Jev](https://typesafe.ai) questions, such as "which category fits this transaction". Only gateways that can reach Jev have `ask()`.

The package has no Agent, Vite, or Nitro code. It works in a plain Node script, a Worker, or another framework, and its only dependency is `nostics`. ViteHub applications import it as `vite-hub/gateways`.

## Install

`languageModel()` and `ask()` load optional peer dependencies only when you use them. `ask()` needs `advocaat`, the TypeSafe client. `languageModel()` needs the AI SDK provider package of its model API, usually `@ai-sdk/openai-compatible`:

```sh
pnpm add @vite-hub/gateways advocaat
pnpm add @vite-hub/gateways ai @ai-sdk/openai-compatible
```

## Use a model with the AI SDK

```ts
import { generateText } from 'ai'
import { openrouter } from '@vite-hub/gateways'
import { languageModel } from '@vite-hub/gateways/ai-sdk'

// Reads OPENROUTER_API_KEY when it sends the request.
const model = languageModel(openrouter(), 'google/gemini-3-flash')

const { text } = await generateText({ model, prompt: 'What is a Server Primitive?' })
```

Change the preset to change the provider. The model ID is the ID that the gateway uses. The `api` option selects the model API, and the type accepts only the APIs that the gateway serves:

| `api` | Request | URL | Package |
| --- | --- | --- | --- |
| `'chat'` | OpenAI Chat Completions | `openai-compatible` | `@ai-sdk/openai-compatible` |
| `'responses'` | OpenAI Responses | `openai-compatible`, else `codex` | `@ai-sdk/openai` |
| `'messages'` | Anthropic Messages | `claude-code` | `@ai-sdk/anthropic` |

The default is `'chat'` when the gateway has an `openai-compatible` URL, else `'messages'`, else `'responses'`. Use `api: 'responses'` for OpenAI reasoning models that call tools. The gateway resolves its URL, key, and headers for each request from the values that you passed or from `process.env`. Pass `fetch` to use a custom fetch implementation. `providerOptions` for `'chat'` go under the gateway name, such as `{ openrouter: { ... } }`; `'responses'` reads `openai` and `'messages'` reads `anthropic`.

## Ask your first question

```ts
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

The answer types come from the questions:

| Builder | Answer |
| --- | --- |
| `ask.choice(instructions, criteria)` | `{ choice, confidence, probabilities }`. `criteria` maps labels to descriptions, or is a list of 2 to 255 labels. |
| `ask.switch(instructions, criteria)` | The selected label only. |
| `ask.score(instructions, levels)` | `{ score, ratio, confidence, legend, probabilities }` for 2 to 10 ordered levels. |
| `ask.chance(instructions, criteria?)` | `{ chance }`, the probability of yes. |
| `ask.if(instructions, { threshold? })` | `true` when the probability of yes is above `threshold`, between `0` and `1`. The default is `0.5`. |
| `ask.each(items, { key, question })` | One question for each item, under the key that `key(item)` returns. |

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
| `chatgpt()` | `https://api.openai.com/v1` through a ChatGPT Connection | | | | None |
| `anthropic()` | | `https://api.anthropic.com` | | | `ANTHROPIC_API_KEY` |
| `typesafe()` | | | | `jev-latest` at `https://api.typesafe.ai` | `TYPESAFE_API_KEY`, `TYPESAFE_DEFAULT_MODEL` |
| `cloudflareTypesafe()` | | | | `jev-latest` through a [custom provider](#typesafe-through-cloudflare-ai-gateway) | `TYPESAFE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, `CLOUDFLARE_AI_GATEWAY_TOKEN` (optional), `CLOUDFLARE_AI_GATEWAY_SLUG` (default `typesafe`) |

The type of a preset lists the model APIs that it serves: `AiGateway<{ routes: "codex" }>` accepts only gateways with a Codex URL, so a ViteHub Codex Driver with `anthropic()` and `languageModel(typesafe(), ...)` are type errors. `vercel()`, `typesafe()`, and `cloudflareTypesafe()` return `AiGateway<{ ask: true }>`. `chatgpt()` returns a `ChatGPTGateway` descriptor for the Agent runtime. The other presets have no `ask()`, so `ask()` on them is a type error. CLIProxyAPI, LiteLLM, Ollama, OpenRouter, OpenAI, Anthropic, and the Cloudflare OpenAI-compatible endpoint forward model APIs only, not TypeSafe's `/v1/systemone`.

`cloudflareAccess()` returns the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers for a gateway behind Cloudflare Access, from `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. Pass it as `headers`, for example `cliproxy({ headers: cloudflareAccess() })`.

`aiGatewayEnv` lists the variables that each preset reads.

## Credentials

`chatgpt({ connection?: string })` is a credential-free descriptor for a ViteHub Codex Driver. It defaults to the `chatgpt` Connection. The Agent runtime applies the Connection's read policy and resolves a fresh plan token. This descriptor has no `apiKey` callback or `ask()` method. Configure `chatgpt({ appName })` from `@vite-hub/connections/chatgpt` on the Connection and sign in with `vitehub connections connect chatgpt`. See [ChatGPT plan usage](https://vitehub.dev/docs/connections/chatgpt).

A preset reads each value that you do not pass when it sends a request. Direct `gateway.ask()` calls, including imports from `vite-hub/gateways`, read `process.env`: `VITEHUB_<PRESET>_<FIELD>` first, such as `VITEHUB_TYPESAFE_API_KEY`, then the vendor variable in the table. Provider Drivers, ask Drivers, `llmGate()`, and `llmRoute()` supply Server Env, with the Cloudflare bindings of the request. `languageModel()` reads `process.env`, also in an AI SDK model Driver. For a direct call with provider-backed Server Env or request bindings, load the values in your application and pass them to the preset.

Vercel keeps its credentials in separate Server Env fields: `vercel.apiKey` reads `AI_GATEWAY_API_KEY`, and `vercel.oidcToken` reads `VERCEL_OIDC_TOKEN`. The API key takes precedence; a token uses OIDC authentication even when an Env provider supplies it.

A value that you pass replaces its variable. Pass the values when the application stores the credentials, for example one key for each tenant:

```ts
import { cloudflare, cloudflareTypesafe, typesafe, vercel } from '@vite-hub/gateways'

typesafe({ apiKey: tenant.typesafeKey })
vercel({ apiKey: tenant.aiGatewayKey })
cloudflare({ accountId, gatewayId, token: tenant.gatewayToken })
cloudflareTypesafe({ apiKey: tenant.typesafeKey, accountId, gatewayId, token, slug })
```

An `apiKey` or header value can also be a function that returns the value for each request. `undefined` fails the request; it does not fall back to the variable. `cloudflare()` is the exception: its provider key is optional. `typesafe()`, `vercel()`, and `cloudflareTypesafe()` also take `model` and `fetch` for `ask()`.

## Cloudflare AI Gateway

`cloudflare()` sends AI SDK model requests to the [OpenAI-compatible endpoint](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/) of a Cloudflare AI Gateway: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat/chat/completions`. Model IDs are `{provider}/{model}`, such as `openai/gpt-5` or `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`.

Each request needs a gateway token, a provider key, or both:

| Setup | Variables | Headers |
| --- | --- | --- |
| The gateway stores the provider keys, or uses Unified Billing | `CLOUDFLARE_AI_GATEWAY_TOKEN` | `cf-aig-authorization` |
| Open gateway, provider key in the request | `CLOUDFLARE_AI_GATEWAY_API_KEY` | `Authorization` |
| Authenticated gateway, provider key in the request | Both | Both |

`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_GATEWAY_ID` are always required. A request without a token and without a key fails with `GATEWAYS_R0002` before it is sent. `cloudflare()` does not route Drivers: Codex and Claude Code need the vendor endpoints of the gateway, each with that vendor's key. To route a Driver through Cloudflare, define a gateway for it.

### TypeSafe through Cloudflare AI Gateway

Cloudflare AI Gateway has no TypeSafe provider. `cloudflareTypesafe()` reaches TypeSafe through a [custom provider](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/) that you create once per Cloudflare account, and answers `ask()`. The gateway then logs each request, and its caching and rate limits apply.

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

   ```sh
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

Use `defineAiGateway()` for an endpoint without a preset. It routes model requests and has no `ask()`. Its type lists the keys of `baseURL`:

```ts
import { defineAiGateway } from '@vite-hub/gateways'

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
| `apiKey` | A string or a function. |
| `apiKeyEnv` | Host variables that supply the key, in order. |
| `auth` | `'bearer'` (default) sends `Authorization: Bearer <key>`. `'x-api-key'` sends `x-api-key: <key>`. |
| `headers` | Extra headers. Each value is a secret, like `apiKey`. |

## Use with ViteHub Agents

In a ViteHub application, set a gateway as `driver.gateway` to route an Agent's model requests, pass `languageModel(gateway, modelId)` from `vite-hub/gateways/ai-sdk` as an AI SDK Driver `model`, or pass a gateway with `ask()` to an ask Driver, `llmGate()`, or `llmRoute()`. ViteHub then declares the preset's variables in Server Env. See [AI gateways](https://vitehub.dev/docs/agents/ai-gateways#use-with-agents) in the ViteHub docs.

`@vite-hub/gateways/internal` is for ViteHub packages: model API route resolution and `ask()` with trace observers.

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
