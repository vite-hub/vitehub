# @vite-hub/gateways

An AI gateway is one object that knows where AI requests go and how to sign them. A gateway has two capabilities:

- **Driver routes.** It routes Codex and Claude Code model requests, for example through Vercel AI Gateway or CLIProxyAPI.
- **`ask()`.** It answers typed [TypeSafe Jev](https://typesafe.ai) questions, such as "which category fits this transaction". Only gateways that can reach Jev have `ask()`.

The package has no Agent, Vite, or Nitro code. It works in a plain Node script or a Worker, and its only dependency is `nostics`. ViteHub applications import it as `vite-hub/gateways`.

## Install

`ask()` also needs `advocaat`, the TypeSafe client. It is an optional peer dependency, and only `ask()` loads it:

```sh
pnpm add @vite-hub/gateways advocaat
```

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

| Preset | Codex | Claude Code | `ask()` | Variables |
| --- | --- | --- | --- | --- |
| `typesafe()` | | | `jev-latest` at `https://api.typesafe.ai` | `TYPESAFE_API_KEY`, `TYPESAFE_DEFAULT_MODEL` |
| `vercel()` | `https://ai-gateway.vercel.sh/codex/v1` | `https://ai-gateway.vercel.sh/claude-code` | `typesafe-ai/jev` at `https://ai-gateway.vercel.sh/v4/ai` | `AI_GATEWAY_API_KEY`, then `VERCEL_OIDC_TOKEN` |
| `cloudflare()` | | | `jev-latest` through a [custom provider](#cloudflare-ai-gateway) | `TYPESAFE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, `CLOUDFLARE_AI_GATEWAY_TOKEN` (optional), `CLOUDFLARE_AI_GATEWAY_SLUG` (default `typesafe`) |
| `cliproxy()` | `<url>/v1` | `<url>` | | `CLIPROXY_URL`, `CLIPROXY_API_KEY` |
| `litellm()` | `<url>/v1` | `<url>` | | `LITELLM_URL`, `LITELLM_API_KEY` |
| `ollama()` | `<url>/v1` | `<url>` | | `OLLAMA_URL` (default `http://localhost:11434`), `OLLAMA_API_KEY` (default `ollama`) |
| `openrouter()` | `https://openrouter.ai/api/v1` | `https://openrouter.ai/api` | | `OPENROUTER_API_KEY` |
| `openai()` | `https://api.openai.com/v1` | | | `OPENAI_API_KEY` |
| `anthropic()` | | `https://api.anthropic.com` | | `ANTHROPIC_API_KEY` |

`typesafe()`, `vercel()`, and `cloudflare()` return `AiGateway<{ ask: true }>`. The other presets return `AiGateway<{ ask: false }>`, so `ask()` on them is a type error. CLIProxyAPI, LiteLLM, Ollama, OpenRouter, OpenAI, and Anthropic forward model APIs only, not TypeSafe's `/v1/systemone`.

`cloudflareAccess()` returns the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers for a gateway behind Cloudflare Access, from `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. Pass it as `headers`, for example `cliproxy({ headers: cloudflareAccess() })`.

`aiGatewayEnv` lists the variables that each preset reads.

## Credentials

A preset reads each value that you do not pass when it sends a request. It reads `VITEHUB_<PRESET>_<FIELD>` first, such as `VITEHUB_TYPESAFE_API_KEY`, then the vendor variable in the table, from `process.env`. In a ViteHub application, it reads Server Env first.

A value that you pass replaces its variable. Pass the values when the application stores the credentials, for example one key for each tenant:

```ts
import { cloudflare, typesafe, vercel } from '@vite-hub/gateways'

typesafe({ apiKey: tenant.typesafeKey })
vercel({ apiKey: tenant.aiGatewayKey })
cloudflare({ apiKey: tenant.typesafeKey, accountId, gatewayId, token, slug })
```

An `apiKey` or header value can also be a function that returns the value for each request. `undefined` fails the request; it does not fall back to the variable. `typesafe()`, `vercel()`, and `cloudflare()` also take `model` and `fetch`, a custom fetch implementation.

## Cloudflare AI Gateway

Cloudflare AI Gateway has no TypeSafe provider. `cloudflare()` reaches TypeSafe through a [custom provider](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/) that you create once per Cloudflare account. The gateway then logs each request, and its caching and rate limits apply.

1. In the Cloudflare dashboard, go to **Compute & AI** > **AI Gateway** and create a gateway. Its name is the gateway ID.
2. Go to **Custom Providers** and select **Add Custom Provider**. Set the slug to `typesafe` and the base URL to `https://api.typesafe.ai`. Or use the Cloudflare API:

   ```sh
   curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/custom-providers \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"name":"TypeSafe","slug":"typesafe","base_url":"https://api.typesafe.ai"}'
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

`cloudflare().ask()` sends `POST https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/custom-<slug>/v1/systemone` with the TypeSafe key as `Authorization` and the gateway token as `cf-aig-authorization`. TypeSafe still bills the requests.

`cloudflare()` does not route Drivers: Cloudflare's OpenAI and Anthropic endpoints each take that vendor's key. To route a Driver through Cloudflare, define a gateway for it.

## Custom gateways

Use `defineAiGateway()` for an endpoint without a preset. It routes Driver model requests and has no `ask()`:

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
| `baseURL` | One URL for each Driver: `codex` (OpenAI Responses at `<url>/responses`) and `claude-code` (Anthropic Messages at `<url>/v1/messages`). A function runs for each request. |
| `apiKey` | A string or a function. |
| `apiKeyEnv` | Host variables that supply the key, in order. |
| `auth` | `'bearer'` (default) sends `Authorization: Bearer <key>`. `'x-api-key'` sends `x-api-key: <key>`. |
| `headers` | Extra headers. Each value is a secret, like `apiKey`. |

## Use with ViteHub Agents

In a ViteHub application, set a gateway as `driver.gateway` to route an Agent's model requests, or pass a gateway with `ask()` to an ask Driver, `llmGate()`, or `llmRoute()`. ViteHub then declares the preset's variables in Server Env. See [AI gateways](https://vitehub.dev/docs/agents/ai-gateways#use-with-agents) in the ViteHub docs.

`@vite-hub/gateways/internal` is for ViteHub packages: Driver route resolution and `ask()` with trace observers.

## Errors

Every error has a `code`, a `why`, and a `fix`. Errors from `ask()` keep the provider error as `cause`.

| Code | When |
| --- | --- |
| `GATEWAYS_R0001` | A gateway definition is not valid, such as an unknown option or a URL that is not http or https. It throws when you call the preset. |
| `GATEWAYS_R0002` | A key is missing or empty. The message names the variable to set, or `apiKey` when you passed it. |
| `GATEWAYS_R0003` | A header value is missing, empty, or has a line break. |
| `GATEWAYS_R0004` | A URL, a Cloudflare account ID, or an AI Gateway ID is missing or not valid. |
| `GATEWAYS_R0005` | `ask()` on a gateway that only routes Driver model requests. |
| `GATEWAYS_R0006` | `ask()` without the `advocaat` package. Install it with `pnpm add advocaat`. |
| `GATEWAYS_R0007` | A Jev question that the `ask` builders do not make, or a question that is too large. |
| `GATEWAYS_R0008` | The provider rejected the key with 401 or 403. `status` is 503, and the error has `providerStatus` and `requestId`. The `fix` names the variable to rotate. |
| `GATEWAYS_R0009` | The provider still failed after three attempts. `status` is 502, and the error has `providerStatus` and `requestId`. |
