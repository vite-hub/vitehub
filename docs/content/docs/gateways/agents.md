---
title: Use AI Gateways with Agents
description: Route Codex, Claude Code, OpenCode, and Pi model requests through a gateway, give an AI SDK model Driver a gateway model, and answer ask Drivers.
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

[Route model requests through a gateway](/docs/agents/agent-drivers#route-model-requests-through-a-gateway) explains how ViteHub configures each harness for a gateway.

### Routes for each harness

Each harness Driver uses one route. Codex uses `codex` (OpenAI Responses), Claude Code uses `claude-code` (Anthropic Messages), Gemini CLI uses `gemini` (Gemini API), and OpenCode, Pi, and Kimi Code use `openai-compatible` (Chat Completions). A preset without that route fails at definition time with `AGENT_R0976`.

| Preset | `codexDriver()` | `claudeCodeDriver()` | `opencodeDriver()`, `piDriver()`, `kimiDriver()` |
| --- | --- | --- | --- |
| `cliproxy()`, `litellm()`, `ollama()` | `<url>/v1` | `<url>` | `<url>/v1` |
| `openrouter()` | `https://openrouter.ai/api/v1` | `https://openrouter.ai/api` | `https://openrouter.ai/api/v1` |
| `vercel()` | `https://ai-gateway.vercel.sh/codex/v1` | `https://ai-gateway.vercel.sh/claude-code` | `https://ai-gateway.vercel.sh/v1` |
| `openai()` | `https://api.openai.com/v1` | | `https://api.openai.com/v1` |
| `chatgpt()` | The ChatGPT plan of a [Connection](/docs/connections/chatgpt) | | |
| `anthropic()` | | `https://api.anthropic.com` | |
| `google()` | | | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `moonshot()` | `https://api.moonshot.ai/v1` | `https://api.moonshot.ai/anthropic` | `https://api.moonshot.ai/v1` |
| `zai()` | `https://api.z.ai/api/v1` | `https://api.z.ai/api/anthropic` | `https://api.z.ai/api/paas/v4`, or `/api/coding/paas/v4` with `codingPlan` |
| `deepseek()` | `https://api.deepseek.com` | `https://api.deepseek.com/anthropic` | `https://api.deepseek.com` |
| `minimax()` | `https://api.minimax.io/v1` | `https://api.minimax.io/anthropic` | `https://api.minimax.io/v1` |
| `alibaba()` | `<workspace>/compatible-mode/v1`, only with `workspaceId` | `<domain>/apps/anthropic` | `<domain>/compatible-mode/v1` |
| `cloudflare()` | | | `.../<account>/<gateway>/compat` |

`emulate()` and `typesafe()` serve no harness. The China regions of `moonshot()`, `zai()`, and `minimax()` use the same paths on their own domains. [Configure](/docs/gateways/configure#model-providers) lists them.

`geminiDriver()` uses the [`gemini` route](/docs/gateways/configure#gemini-cli), which `google()`, `cliproxy()`, and `litellm()` serve. Antigravity, Cursor, Grok, Kiro, fx, Muse, and ACP agents take no gateway. They sign in to their own service, and `driver.gateway` fails with `AGENT_R0976`.

`aiGatewayHarnessRoute(gateway, harness)` returns the route key that a preset gives a harness, or `undefined`.

### Model IDs for each provider

The model ID depends on the preset. A model provider preset takes the provider's own ID, and `openrouter()` takes `<vendor>/<model>`. These IDs were current on 27 November 2026, and each one supports tool calls:

| Models | Model provider preset | `openrouter()` |
| --- | --- | --- |
| Kimi | `moonshot()`: `kimi-k3.1-pro` | `moonshotai/kimi-k3.1-pro` |
| GLM | `zai()`: `glm-5.3` | `z-ai/glm-5.3` |
| DeepSeek | `deepseek()`: `deepseek-v4-pro` | `deepseek/deepseek-v4-pro` |
| MiniMax | `minimax()`: `MiniMax-M3` | `minimax/minimax-m3` |
| Qwen | `alibaba()`: `qwen3.7-plus` | `qwen/qwen3.7-plus` |
| Gemini | `google()`: `gemini-3.8-flash` | `google/gemini-3.8-flash` |

```ts [server/agents/review/agent.ts]
import { claudeCodeDriver, defineAgent } from 'vite-hub/agent'
import { zai } from 'vite-hub/gateways'

export default defineAgent({
  driver: claudeCodeDriver({ model: 'glm-5.3', gateway: zai() }),
})
```

```ts [server/agents/review/agent.ts]
import { defineAgent, opencodeDriver } from 'vite-hub/agent'
import { openrouter } from 'vite-hub/gateways'

export default defineAgent({
  driver: opencodeDriver({ model: 'qwen/qwen3.7-plus', gateway: openrouter(), permissions: 'allow-all' }),
})
```

## Give a model Driver a gateway model

An AI SDK model Driver can take its model from `languageModel()`, so requests use your gateway instead of the Vercel AI Gateway:

```ts [server/agents/support/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { openrouter } from 'vite-hub/gateways'
import { languageModel } from 'vite-hub/gateways/ai-sdk'

export default defineAgent({
  driver: { model: languageModel(openrouter(), 'google/gemini-3.8-flash') },
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

ViteHub declares gateway variables in Server Env for the presets that any server file imports from `vite-hub/gateways`, such as an Agent file or a Channel that asks a question with `defineChoices()`, as `env.server.<preset>.<field>`, such as `env.server.cloudflare.accountId`. A preset reads its own `VITEHUB_<PRESET>_<FIELD>` first, such as `VITEHUB_CLOUDFLARE_TYPESAFE_API_KEY` for the TypeSafe key of `cloudflare()`. The Console shows them, and an [Env provider](/docs/env/server-api#read-external-env-storage) can supply them. They stay optional, so a server that does not use the gateway still starts. For the default `typesafe()` gateway, add `typesafe: typesafeEnv()` from `vite-hub/env` to `env.server`.
