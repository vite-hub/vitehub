---
title: AI Gateways configuration
description: Pick a preset for your provider, pass or read its keys, and set up Cloudflare AI Gateway and TypeSafe through it.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

A preset is a ready-made gateway for one provider. Its type says what it serves. For an endpoint without a preset, use [`defineAiGateway()`](/docs/gateways/server-api#custom-gateways).

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
| `chatgpt()` | `https://api.openai.com/v1` through a ChatGPT Connection | | | | None |
| `anthropic()` | | `https://api.anthropic.com` | | | `ANTHROPIC_API_KEY` |
| `typesafe()` | | | | `jev-latest` at `https://api.typesafe.ai` | `TYPESAFE_API_KEY`, `TYPESAFE_DEFAULT_MODEL` |

Preset types list what they serve, so TypeScript catches a wrong gateway:

- `AiGateway<{ routes: "codex" }>` accepts only gateways with a Codex URL, so `driver: codexDriver({ gateway: anthropic() })` and `languageModel(typesafe(), ...)` are type errors.
- Only `vercel()`, `typesafe()`, and `cloudflare()` return `AiGateway<{ ask: true }>`; `ask()` on others is a type error.
- CLIProxyAPI, LiteLLM, Ollama, OpenRouter, OpenAI, Anthropic, and the Cloudflare OpenAI-compatible endpoint forward only model APIs, not TypeSafe's `/v1/systemone`.
- `chatgpt()` has no key and no `ask()`. It uses the plan of a ChatGPT [Connection](/docs/connections/chatgpt). Only the Agent runtime reads it.

Behind Cloudflare Access, pass `cloudflareAccess()` as `headers`, such as `cliproxy({ headers: cloudflareAccess() })`. It returns `CF-Access-Client-Id` and `CF-Access-Client-Secret` from `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.

`aiGatewayEnv` lists the variables that each preset reads.

## Credentials

A preset reads each value that you did not pass when it sends a request:

- Direct `gateway.ask()` calls, including imports from `vite-hub/gateways`, read `process.env`: `VITEHUB_<PRESET>_<FIELD>` first, such as `VITEHUB_TYPESAFE_API_KEY`, then the vendor variable in the table.
- Provider Drivers and ask Drivers supply [Server Env](/docs/env/configure) with the request's Cloudflare bindings.
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

`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_GATEWAY_ID` are always required. A request with neither token nor provider key fails with [`GATEWAYS_R0002`](/docs/gateways/limits-and-errors#gateways_r0002) before it is sent. The keys never mix: `ask()` sends only the TypeSafe key, and model requests only the provider key. `cloudflare({ apiKey })` throws with an error that names both options.

`cloudflare()` does not route Drivers. Codex and Claude Code need the gateway's vendor endpoints, such as `.../openai` with an OpenAI key or `.../anthropic` with an Anthropic key in `x-api-key`. [Custom gateways](/docs/gateways/server-api#custom-gateways) defines one for Codex through Cloudflare.

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
