---
title: Agent usage
description: Define agents, customize runtime placement, and compose with workflow or sandbox.
navigation.title: Usage
navigation.order: 3
icon: i-lucide-file-code-2
frameworks: [vite, nitro]
---

## Discovery

Vite and Nitro use separate discovery rules.

::fw{id="vite:dev vite:build"}
```txt
src/triager.agent.ts
src/support/reviewer.agent.ts
```
::

::fw{id="nitro:dev nitro:build"}
```txt
server/agents.ts
server/agents/triager.ts
server/agents/support/reviewer.ts
```
::

Use `server/agents.ts` when you prefer named exports:

```ts [server/agents.ts]
export const triager = defineAgent({
  model,
  instructions: 'Triage support requests.',
})
```

## Configure runtime choices

Keep the agent definition portable and choose runtime placement from config.

```ts
agent: {
  route: '/agents/[agent]',
  runtime: 'auto',
  execution: 'inline',
  integrations: {
    workflow: 'auto',
    sandbox: 'auto',
  },
  providers: {
    model: { provider: 'vercel-ai-sdk' },
    state: { provider: 'auto' },
    scheduler: { provider: 'auto' },
    sandbox: { provider: 'auto' },
  },
}
```

Set `agent.route` to `false` to disable generated Nitro routes.

## Custom run behavior

Use `run` when the default AI SDK `generate()` / `stream()` behavior is not enough.

```ts
export default defineAgent({
  model,
  instructions: 'Answer with short operational guidance.',
  async run({ input, streamText }) {
    return streamText({
      messages: input.messages || [],
    })
  },
})
```

## Use agents from Chat

`@vitehub/chat` can resolve discovered agents by name when both packages are enabled.

```ts [server/chat.ts]
export default defineChat({
  adapters,
  agent: 'triager',
  state,
  userName: 'Support Bot',
})
```

Chat owns the chat-specific work: gathering thread history, converting messages, and posting the streamed response. Agent definitions stay portable and do not import Chat.

## Cloudflare Agents

Cloudflare Agents are runtime primitives for state, scheduling, Durable Objects, and native agent routing. Use `@vitehub/agent/cloudflare` when you want to delegate to Cloudflare's native `routeAgentRequest()` path.
