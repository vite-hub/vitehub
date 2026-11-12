---
title: AI Gateways
layout: landing
navigation.title: Overview
description: Send AI model requests through one gateway object, and ask typed TypeSafe Jev questions, from Agents, Decisions, or your own server code.
navigation.order: 1
icon: i-lucide-waypoints
---

::product-hero{tagline="One object knows where AI requests go and how to sign them. Agents, Decisions, and your routes share it."}
  :::code-tree
  ```ts [server/api/answer.get.ts]
  import { generateText } from 'ai'
  import { defineEventHandler } from 'h3'
  import { openrouter } from 'vite-hub/gateways'
  import { languageModel } from 'vite-hub/gateways/ai-sdk'

  // Reads OPENROUTER_API_KEY when it sends the request
  const model = languageModel(openrouter(), 'google/gemini-3-flash')

  export default defineEventHandler(async () => {
    const { text } = await generateText({ model, prompt: 'What is a Server Primitive?' })
    return { text }
  })
  ```

  ```ts [server/agents/review/agent.ts]
  import { codexDriver, defineAgent } from 'vite-hub/agent'
  import { cliproxy } from 'vite-hub/gateways'

  // Codex sends its model requests through your CLIProxyAPI
  export default defineAgent({
    driver: codexDriver({ model: 'gpt-5.5', gateway: cliproxy() }),
  })
  ```

  ```ts [server/utils/label.ts]
  import { ask, typesafe } from 'vite-hub/gateways'

  // Reads TYPESAFE_API_KEY. The answer types come from the questions.
  export function label(transaction: string) {
    return typesafe().ask(transaction, {
      category: ask.choice('Which category fits this bank transaction?', {
        groceries: 'Food and household shopping.',
        eatingOut: 'Restaurants and cafes.',
      }),
      recurring: ask.if('Is it a recurring payment?'),
    })
  }
  ```
  :::
::

::product-features
  :::product-feature-item{title="Use it with the AI SDK" icon="i-lucide-sparkles" to="/docs/gateways/get-started#send-a-prompt"}
  `languageModel()` returns an AI SDK model that sends its requests through the gateway.
  :::

  :::product-feature-item{title="Route Codex and Claude Code" icon="i-lucide-bot" to="/docs/gateways/agents"}
  Set `driver.gateway`, and the Agent Driver sends its model requests through your proxy.
  :::

  :::product-feature-item{title="Ask typed questions" icon="i-lucide-list-checks" to="/docs/gateways/server-api#ask-questions"}
  `ask()` sends questions to TypeSafe Jev, and TypeScript infers each answer type.
  :::

  :::product-feature-item{title="A preset for each provider" icon="i-lucide-waypoints" to="/docs/gateways/configure#presets"}
  Vercel, Cloudflare, OpenRouter, LiteLLM, CLIProxyAPI, Ollama, OpenAI, Anthropic, and TypeSafe. The type tells what each one serves.
  :::

  :::product-feature-item{title="Keys stay on the server" icon="i-lucide-key-round" to="/docs/gateways/configure#credentials"}
  A preset reads its key for each request, so a rotated key applies at once.
  :::

  :::product-feature-item{title="No framework code" icon="i-lucide-box" to="/docs/gateways/server-api"}
  The package has no Agent, Vite, or Nitro code. It also runs in a plain Node script or a Worker.
  :::
::

::agent-only
Use AI Gateways when server code sends model requests or asks typed questions. Import presets from `vite-hub/gateways` and `languageModel()` from `vite-hub/gateways/ai-sdk`. Install `@vite-hub/gateways`, plus `advocaat` for `ask()` and the AI SDK provider package for `languageModel()`.

Pick a preset whose type serves the use: a Codex or Claude Code URL for a Driver, an OpenAI-compatible URL for `languageModel()`, and `ask: true` for `ask()`. Never import a gateway in browser code. Keys are read on the server for each request.

Prove it with a real request and a real key. Without a key, show that the request fails with `GATEWAYS_R0002` and the variable that it names.
::
