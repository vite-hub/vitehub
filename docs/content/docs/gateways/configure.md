---
title: AI Gateways configuration
description: Pick a preset for your provider, pass or read its keys, and set up Cloudflare AI Gateway and TypeSafe through it.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

A preset is a ready-made gateway for one provider. Its type says what it serves. For an endpoint without a preset, use [`defineAiGateway()`](/docs/gateways/server-api#custom-gateways).

## Presets

| Preset | Codex | Claude Code | Gemini | OpenAI-compatible | `ask()` | Variables |
| --- | --- | --- | --- | --- | --- | --- |
| `vercel()` | `https://ai-gateway.vercel.sh/codex/v1` | `https://ai-gateway.vercel.sh/claude-code` | | `https://ai-gateway.vercel.sh/v1` | `typesafe-ai/jev` at `https://ai-gateway.vercel.sh/v4/ai` | `AI_GATEWAY_API_KEY`, then `VERCEL_OIDC_TOKEN` |
| `cloudflare()` | | | | `.../<account>/<gateway>/compat` | `jev-latest` through a [custom provider](#typesafe-through-cloudflare-ai-gateway) | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, `CLOUDFLARE_AI_GATEWAY_TOKEN`, `CLOUDFLARE_AI_GATEWAY_API_KEY`, `TYPESAFE_API_KEY`, `CLOUDFLARE_AI_GATEWAY_SLUG` (see [Cloudflare AI Gateway](#cloudflare-ai-gateway)) |
| `openrouter()` | `https://openrouter.ai/api/v1` | `https://openrouter.ai/api` | | `https://openrouter.ai/api/v1` | | `OPENROUTER_API_KEY` |
| `litellm()` | `<url>/v1` | `<url>` | `<url>` | `<url>/v1` | | `LITELLM_URL`, `LITELLM_API_KEY` |
| `cliproxy()` | `<url>/v1` | `<url>` | `<url>` | `<url>/v1` | | `CLIPROXY_URL`, `CLIPROXY_API_KEY` |
| `ollama()` | `<url>/v1` | `<url>` | | `<url>/v1` | | `OLLAMA_URL` (default `http://localhost:11434`), `OLLAMA_API_KEY` (default `ollama`) |
| `emulate()` | | `<url>` (AI SDK `messages` only) | | `<url>/v1` | | `VITEHUB_EMULATE_URL` (default `http://localhost:4014`). No key. |
| `google()` | | | `https://generativelanguage.googleapis.com` | `https://generativelanguage.googleapis.com/v1beta/openai` (`api: 'chat'` only) | | `GEMINI_API_KEY` |
| `moonshot()` | `https://api.moonshot.ai/v1` | `https://api.moonshot.ai/anthropic` | | `https://api.moonshot.ai/v1` | | `MOONSHOT_API_KEY`, then `KIMI_API_KEY` |
| `zai()` | `https://api.z.ai/api/v1` | `https://api.z.ai/api/anthropic` | | `https://api.z.ai/api/paas/v4` (no `api: 'responses'`) | | `ZAI_API_KEY` |
| `deepseek()` | | `https://api.deepseek.com/anthropic` | | `https://api.deepseek.com` (no `api: 'responses'`) | | `DEEPSEEK_API_KEY` |
| `minimax()` | `https://api.minimax.io/v1` | `https://api.minimax.io/anthropic` | | `https://api.minimax.io/v1` | | `MINIMAX_API_KEY` |
| `alibaba()` | `<workspace>/compatible-mode/v1`, only with `workspaceId` | `<domain>/apps/anthropic` | | `<domain>/compatible-mode/v1` (`api: 'responses'` only with `workspaceId`) | | `DASHSCOPE_API_KEY` |
| `openai()` | `https://api.openai.com/v1` | | | `https://api.openai.com/v1` | | `OPENAI_API_KEY` |
| `chatgpt()` | `https://api.openai.com/v1` through a ChatGPT Connection | | | | | None |
| `anthropic()` | | `https://api.anthropic.com` | | | | `ANTHROPIC_API_KEY` |
| `typesafe()` | | | | | `jev-latest` at `https://api.typesafe.ai` | `TYPESAFE_API_KEY`, `TYPESAFE_DEFAULT_MODEL` |

Preset types list what they serve, so TypeScript catches a wrong gateway:

- `AiGateway<{ routes: "codex" }>` accepts only gateways with a Codex URL, so `driver: codexDriver({ gateway: anthropic() })` and `languageModel(typesafe(), ...)` are type errors.
- A preset whose endpoint lacks a model API rejects it: `languageModel(deepseek(), 'deepseek-chat', { api: 'responses' })` is a type error.
- Only `vercel()`, `typesafe()`, and `cloudflare()` return `AiGateway<{ ask: true }>`; `ask()` on others is a type error.
- CLIProxyAPI, LiteLLM, Ollama, the AI emulator, OpenRouter, the [model providers](#model-providers), OpenAI, Anthropic, and the Cloudflare OpenAI-compatible endpoint forward only model APIs, not TypeSafe's `/v1/systemone`.
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

## Gemini CLI

The `gemini` route serves the [Gemini CLI](https://github.com/google-gemini/gemini-cli). The CLI sends Gemini API requests to `<url>/v1beta/models/<model>:generateContent`, with the key in `x-goog-api-key`. `google()`, `cliproxy()`, and `litellm()` serve it.

The Gemini CLI reads the URL from `GOOGLE_GEMINI_BASE_URL` and the key from `GEMINI_API_KEY`. To send it through your CLIProxyAPI:

```sh
GOOGLE_GEMINI_BASE_URL=$CLIPROXY_URL GEMINI_API_KEY=$CLIPROXY_API_KEY gemini
```

- A gateway sends the key of the `gemini` route only in `x-goog-api-key`, whatever its `auth`.
- `aiGatewayHarnessRoute(gateway, harness)` returns the route that a coding agent CLI uses on a gateway, or `undefined`. Claude Code uses `claude-code`, Codex uses `codex`, the Gemini CLI uses `gemini`, and Kimi CLI, OpenCode, and Pi use `openai-compatible`.
- `AiGateway<{ routes: AiGatewayHarnessRoute<'gemini'> }>` accepts only gateways that serve the Gemini CLI, so `ollama()` is a type error there.

## Model providers

These presets send requests to the API of one model provider, with no proxy between. Use them for open-weight and Chinese models, such as Kimi, GLM, DeepSeek, MiniMax, and Qwen. Each one reads the provider's own key. The key works only in the region where you created it, so pass the same region to the preset.

| Preset | Models | Options | Default | Other regions |
| --- | --- | --- | --- | --- |
| `google()` | Gemini | | `generativelanguage.googleapis.com` | |
| `moonshot()` | Kimi | `region` | `api.moonshot.ai` | `'china'`: `api.moonshot.cn` |
| `zai()` | GLM | `region`, `codingPlan` | `api.z.ai` | `'china'`: `open.bigmodel.cn` |
| `deepseek()` | DeepSeek | | `api.deepseek.com` | |
| `minimax()` | MiniMax | `region` | `api.minimax.io` | `'china'`: `api.minimax.cn` |
| `alibaba()` | Qwen | `region`, `workspaceId` | `dashscope-intl.aliyuncs.com` (`ap-southeast-1`) | `cn-beijing`, `cn-hongkong`, and, with `workspaceId`, `ap-northeast-1`, `eu-central-1`, `us-east-1` |

### Google

`google()` uses the [Gemini API](https://aistudio.google.com/api-reference). It serves the Gemini CLI and AI SDK models through its [OpenAI-compatible endpoint](https://aistudio.google.com/docs/openai), which has Chat Completions only. It has no Codex or Claude Code URL.

```ts [server/api/answer.ts]
import { google } from 'vite-hub/gateways'
import { languageModel } from 'vite-hub/gateways/ai-sdk'

// Reads GEMINI_API_KEY.
const model = languageModel(google(), 'gemini-3-flash', { api: 'chat' })
```

### Moonshot AI

`moonshot()` uses the [Kimi API](https://platform.kimi.ai/docs/api/overview). It serves Codex, Claude Code, and AI SDK models.

```ts [server/agents/review/agent.ts]
import { claudeCodeDriver, defineAgent } from 'vite-hub/agent'
import { moonshot } from 'vite-hub/gateways'

// Reads MOONSHOT_API_KEY, then KIMI_API_KEY. A key from platform.kimi.com needs region: 'china'.
export default defineAgent({
  driver: claudeCodeDriver({ model: 'kimi-k2.5', gateway: moonshot() }),
})
```

### Z.ai

`zai()` uses the [Z.ai API](https://docs.z.ai/guides/overview/quick-start) for GLM models. It serves Codex, Claude Code, and AI SDK models with `api: 'chat'` and `'messages'`. A GLM Coding Plan key needs `codingPlan: true`, which sends Chat Completions to `/api/coding/paas/v4` ([endpoints](https://docs.z.ai/devpack/notice/api-key-management)).

```ts [server/agents/review/agent.ts]
import { claudeCodeDriver, defineAgent } from 'vite-hub/agent'
import { zai } from 'vite-hub/gateways'

// Reads ZAI_API_KEY. A key from bigmodel.cn needs region: 'china'.
export default defineAgent({
  driver: claudeCodeDriver({ model: 'glm-5', gateway: zai({ codingPlan: true }) }),
})
```

### DeepSeek

`deepseek()` uses the [DeepSeek API](https://api-docs.deepseek.com). It serves Claude Code through its [Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api), and AI SDK models with `api: 'chat'` and `'messages'`. DeepSeek has no OpenAI Responses API, so `codexDriver({ gateway: deepseek() })` is a type error.

```ts [server/api/answer.ts]
import { deepseek } from 'vite-hub/gateways'
import { languageModel } from 'vite-hub/gateways/ai-sdk'

// Reads DEEPSEEK_API_KEY.
const model = languageModel(deepseek(), 'deepseek-chat', { api: 'chat' })
```

### MiniMax

`minimax()` uses the [MiniMax API](https://platform.minimax.io/docs/api-reference/text-anthropic-api). It serves [Codex](https://platform.minimax.io/docs/m-plan/codex), Claude Code, and AI SDK models.

```ts [server/agents/review/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { minimax } from 'vite-hub/gateways'

// Reads MINIMAX_API_KEY. A key from minimax.cn needs region: 'china'.
export default defineAgent({
  driver: codexDriver({ model: 'MiniMax-M2.5', gateway: minimax() }),
})
```

### Alibaba Cloud Model Studio

`alibaba()` uses [Model Studio](https://www.alibabacloud.com/help/en/model-studio/regions/) for Qwen models. Without `workspaceId`, it uses the DashScope domain of the region, which serves Claude Code and AI SDK models with `api: 'chat'` and `'messages'`. With `workspaceId`, it uses the workspace domain `<workspaceId>.<region>.maas.aliyuncs.com`, which also serves Codex and `api: 'responses'` through the [Responses API](https://www.alibabacloud.com/help/en/model-studio/compatibility-with-openai-responses-api). Only the workspace domain exists in `ap-northeast-1`, `eu-central-1`, and `us-east-1`.

```ts [server/agents/review/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { alibaba } from 'vite-hub/gateways'

// Reads DASHSCOPE_API_KEY. The key and the workspace must be in the same region.
export default defineAgent({
  driver: codexDriver({ model: 'qwen3-coder-plus', gateway: alibaba({ region: 'us-east-1', workspaceId: 'ws-...' }) }),
})
```

## AI emulator

`emulate()` sends model requests to the [AI emulator](https://emulate.dev/docs/ai) (`@emulators/ai`). The emulator answers from rules that you write, not from a model, so the same request gets the same answer each time. Use it in dev and tests. It needs no AI key.

Start the emulator:

```sh
npx emulate@0.14.0 start --service ai --port 4014
```

Then use it like any other gateway:

```ts [server/api/answer.ts]
import { generateText } from 'ai'
import { emulate } from 'vite-hub/gateways'
import { languageModel } from 'vite-hub/gateways/ai-sdk'

// Reads VITEHUB_EMULATE_URL, else uses http://localhost:4014.
const model = languageModel(emulate(), 'gpt-5.1', { api: 'responses' })

const { text } = await generateText({ model, prompt: 'Hello' })
```

- `emulate()` serves AI SDK models with `api: 'chat'`, `'responses'`, and `'messages'`. The emulator accepts any model ID.
- Without a matching rule, the emulator returns a default reply. For `Output.object()` and `generateObject()`, that reply follows your schema on all three APIs.
- It reads no credentials. It sends the key `emulate`, because the AI SDK providers need a key.
- `emulate({ url })` replaces `VITEHUB_EMULATE_URL`.
- To send the models of all Agents to the emulator without a change to the Agent files, set `VITEHUB_MODELS=emulate`. Read [Run on the AI emulator](/docs/agents/agent-drivers#run-on-the-ai-emulator).
- In a test, start the emulator in the test process with `createEmulator({ service: 'ai', port: 0, seed: { ai: { strict: true, rules } } })` from the `emulate` package, and pass its `url`. With `strict: true`, a request that no rule matches fails with a 400 that shows the missing rule. In an Agent test, [`emulateModels()`](/docs/agents/testing#run-the-model-driver-without-an-ai-key) does this for you.
- `GET <url>/_ai/calls` lists each request and the rule that answered it.
- The emulator rejects hosted tools, such as web search.
- It does not serve the CLI Drivers. It has no Codex URL, so `codexDriver({ gateway: emulate() })` is a type error, because the emulator rejects the `custom` tools that the Codex CLI sends. To run a Codex Agent without tools on the emulator, set `VITEHUB_MODELS=emulate`, and ViteHub sets up Codex for it. Read [Run on the AI emulator](/docs/agents/agent-drivers#run-on-the-ai-emulator). Claude Code cannot use it either, because the emulator rejects its `system` turns. Its URL is there only for AI SDK `messages` models.

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
