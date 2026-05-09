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

## Expose an agent route

Keep agents internal by default. Chat can still resolve discovered agents through the generated registry.

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/agent/nitro'],
  agent: {
    route: true,
  },
})
```
::

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { hubAgent } from '@vitehub/agent/vite'

export default defineConfig({
  plugins: [
    hubAgent({
      route: true,
    }),
  ],
})
```
::

Only set `route` when agents should be externally callable. Use this for trusted server-to-server calls or put your own auth in front of the route. Use a custom route string when `/agents/[agent]` does not fit your app.

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

## Answer from a Workspace

Use `@vitehub/agent/workspace` when an agent should read a ViteHub Workspace and answer from those sources. The helper wires the Workspace tools into an AI SDK `ToolLoopAgent`, reads an optional instructions file, and returns a final answer that Chat can post.

::fw{id="nitro:dev nitro:build"}
```ts [server/agents/context.ts]
import { createVertex } from '@ai-sdk/google-vertex/edge'
import { defineWorkspaceAgent } from '@vitehub/agent/workspace'
import { useSafeRuntimeConfig } from '#vitehub/env/server'

type RuntimeConfig = ReturnType<typeof useSafeRuntimeConfig>

export default defineWorkspaceAgent<RuntimeConfig>({
  description: 'Answer with workspace context.',
  workspace: 'data-sources',
  instructions: 'Use the workspace sources. Say what is missing when the sources do not answer.',
  instructionsFile: true,
  model: ({ runtimeConfig }) => {
    const vertex = createVertex({ apiKey: runtimeConfig.vertex.apiKey })
    return vertex(runtimeConfig.vertex.model)
  },
  stepLimit: 60,
})
```
::

Pair it with the Chat agent binding:

```ts [server/chat.ts]
export default defineChat({
  adapters,
  agent: 'context',
  state,
})
```

## Cloudflare Agents

Cloudflare Agents are runtime primitives for state, scheduling, Durable Objects, and native agent routing. Use `@vitehub/agent/cloudflare` when you want to delegate to Cloudflare's native `routeAgentRequest()` path.
