---
title: Run Agents with no AI key
description: Run Agents in dev and tests on the AI emulator, which answers from rules that you write and never calls a real provider.
navigation.title: Run with no AI key
navigation.order: 51.5
navigation.group: Inspect and evaluate
icon: i-lucide-key-round
navigation.kind: Guides
---

The AI emulator (`@emulators/ai`) is a local server that speaks the OpenAI and Anthropic model APIs. It answers from rules that you write, not from a model. Turn it on, and your Agents run in dev and tests with no AI key. The Agent files do not change, and no request goes to a real provider.

## Turn it on in dev

Install the emulator packages, and `@ai-sdk/openai` for the `openai/*` model ID below:

```bash pm
pnpm add -D @emulators/core@0.14.0 @emulators/ai@0.14.0
pnpm add @ai-sdk/openai
```

The emulator answers model-backed Agents. A function Driver, such as the one in the first lesson, sends no model request. Add an Agent with a model Driver:

```ts [server/agents/greeter.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1' },
})
```

Set `agent.models.emulate` and write one rule:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    agent: {
      models: {
        emulate: {
          rules: [{ id: 'greet', match: { textContains: 'hello' }, reply: [{ type: 'text', text: 'Hello from the seeded rule.' }] }],
        },
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [
    vitehub({
      agent: {
        models: {
          emulate: {
            rules: [{ id: 'greet', match: { textContains: 'hello' }, reply: [{ type: 'text', text: 'Hello from the seeded rule.' }] }],
          },
        },
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    agent: {
      models: {
        emulate: {
          rules: [{ id: 'greet', match: { textContains: 'hello' }, reply: [{ type: 'text', text: 'Hello from the seeded rule.' }] }],
        },
      },
    },
  })],
})
```
:::
::

Start the dev server and send a prompt:

```bash [Terminal]
pnpm vitehub agent dev --agent greeter --prompt 'hello there'
```

```txt [Output]
Hello from the seeded rule.
```

The `greet` rule answered, and no request went to OpenAI.

- `vite dev` starts the emulator on a free loopback port and sets `VITEHUB_MODELS=emulate`. `vite build` does not start it. See [Run on the AI emulator](/docs/agents/agent-drivers#run-on-the-ai-emulator) for the seed options, restarts, and Cloudflare dev.
- The [rule reference](https://emulate.dev/docs/ai) shows how to match a prompt, call a tool, and answer after a tool result.

## See which rule answered

```bash [Terminal]
pnpm vitehub agent emulator
```

The command prints the rules and the recent calls, with the rule that answered each call. `--json` prints the same data for a script. See [Inspect the AI emulator](/docs/cli/agents#inspect-the-ai-emulator).

## Use it in tests and CI

- In a Vitest test, `await using ai = await emulateModels({ rules })` starts an emulator for that test. See [Run the model Driver without an AI key](/docs/agents/testing#run-the-model-driver-without-an-ai-key).
- To use an emulator that you start yourself, set `VITEHUB_MODELS=emulate` and `VITEHUB_EMULATE_URL`. The default URL is `http://localhost:4014`.
- To send one model to the emulator without the switch, use the [`emulate()` gateway](/docs/gateways/configure#ai-emulator).

Do not score [Evals](/docs/agents/evals) on the emulator. It returns the answers of your rules, so an Eval scores the rules, not a model.

## What runs on the emulator

ViteHub checks the switch before it reads a credential. When a case cannot run on the emulator, ViteHub fails with a named code and does not start the provider.

| Case | Result | Fix |
| --- | --- | --- |
| Model Driver: a model ID, `languageModel()`, `chatgpt()`, and Capability models such as `title()` | Runs on the emulator. | |
| Codex Driver without Capability tools | Runs on the emulator. See the Codex notes in [Run on the AI emulator](/docs/agents/agent-drivers#run-on-the-ai-emulator). | |
| Codex Driver with Capability tools | `AGENT_MODELS_EMULATE_CODEX_TOOLS_UNSUPPORTED` | Remove the tools, or use a model Driver. |
| Codex Driver with a `sandbox` | `AGENT_MODELS_EMULATE_SANDBOX_UNSUPPORTED` | Remove `sandbox` while you run on the emulator. |
| Claude Code Driver | `AGENT_MODELS_EMULATE_CLAUDE_CODE_UNSUPPORTED` | Use a model Driver, or Codex without tools. |
| A model from an AI SDK provider, such as `createOpenAI()` | `AGENT_MODELS_EMULATE_MODEL_UNSUPPORTED` | Use a model ID or `languageModel(gateway, id)`. |
| An ask Driver | `AGENT_MODELS_EMULATE_ASK_UNSUPPORTED` | Use a model Driver. |
| A hosted tool, such as `webSearch({ mode: 'model' })` | Runs without the tool, with the warning `AGENT_MODELS_EMULATE_PROVIDER_TOOL_DROPPED`. See [Web search](/docs/agents/capabilities/web-search#how-web-search-works). | Use `webSearch({ mode: 'tool', provider })`. Tool mode still calls your search provider, with its key. Only the model request goes to the emulator. |
| A tool choice that only a dropped tool can satisfy | Runs with tool choice `'auto'`, with the warning `AGENT_MODELS_EMULATE_TOOL_CHOICE_RELAXED`. | Use `webSearch({ mode: 'tool', provider })`. |
| A production build, or `NODE_ENV=production` | `AGENT_MODELS_EMULATE_IN_PRODUCTION` | Remove `VITEHUB_MODELS` from production. |
| `VITEHUB_MODELS` set to a value other than `emulate` | `AGENT_MODELS_INVALID` | Set `emulate`, or unset it. |
| The emulator packages are not installed | `AGENT_EMULATOR_PACKAGES_MISSING` | Install `@emulators/core` and `@emulators/ai`. |
| The emulator rejects a rule | `AGENT_EMULATOR_RULES_INVALID` | Fix the rule field that the message names. |
| `vitehub agent emulator` finds no emulator | `AGENT_EMULATOR_NOT_RUNNING` | Start the dev server with the option, or set `VITEHUB_EMULATE_URL`. |
| Two `emulateModels()` scopes in one test worker | `AGENT_EMULATOR_SCOPE_ACTIVE` | Close the first scope before you start the next. |
| A call after `emulateModels()` closes | `AGENT_EMULATOR_CLOSED` | Read the calls before `close()`. |
| `emulate({ url: '' })` | `GATEWAYS_R0001` | Pass a URL, or remove `url` to use `VITEHUB_EMULATE_URL`. |
