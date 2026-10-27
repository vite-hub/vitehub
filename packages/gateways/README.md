# @vite-hub/gateways

`@vite-hub/gateways` gives one object for where AI requests go: an AI gateway. A gateway routes Codex and Claude Code model requests, and the gateways that can reach TypeSafe Jev also answer typed questions with `ask()`. It has no Agent, Vite, or Nitro code, so it works in any Node or Workers runtime. ViteHub applications import it as `vite-hub/gateways`.

```sh
pnpm add @vite-hub/gateways advocaat
```

```ts
import { ask, cloudflare, typesafe } from '@vite-hub/gateways'

const answers = await typesafe().ask('MERCADONA 23.10', {
  groceries: ask.if('Is this a grocery purchase?'),
})

// One key per tenant: passed values replace the variables.
await cloudflare({ apiKey, accountId, gatewayId, token }).ask(state, questions)
```

`advocaat` is an optional peer dependency. Only `ask()` loads it.

## Public imports

| Import | Use |
| --- | --- |
| `typesafe()`, `vercel()`, `cloudflare()` | Gateways with `ask()`: TypeSafe directly, Vercel AI Gateway (`typesafe-ai/jev`), or TypeSafe through a Cloudflare AI Gateway custom provider. `vercel()` also routes Codex and Claude Code. |
| `cliproxy()`, `litellm()`, `ollama()`, `openrouter()`, `openai()`, `anthropic()` | Gateways that route Codex and Claude Code model requests only. |
| `defineAiGateway(definition)` | A gateway for an endpoint without a preset. |
| `cloudflareAccess()` | Cloudflare Access service-token headers for a gateway behind Access. |
| `ask` | The Jev question builders: `ask.choice()`, `ask.switch()`, `ask.score()`, `ask.chance()`, `ask.if()`, and `ask.each()`. |
| `AiGateway<{ ask: true }>`, `AiGateway<{ ask: false }>` | The gateway type. `ask()` exists only with `ask: true`. |
| `aiGatewayEnv` | The variables that each preset reads. |

Each preset reads a value that it did not receive when it sends a request: `VITEHUB_<PRESET>_<FIELD>`, then the vendor variable, such as `TYPESAFE_API_KEY`. A resolver context can supply `env(preset, field)` instead; ViteHub Agents read Server Env there.

`@vite-hub/gateways/internal` is for ViteHub packages: Driver route resolution and `ask()` with trace observers.

See [AI gateways](../../docs/content/docs/agents/ai-gateways.md) for the preset table, credentials, Cloudflare setup, and errors.
