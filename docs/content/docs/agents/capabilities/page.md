---
title: Page
description: Let an Agent read and change the person's open page through ui-sdk's agent bridge, over Realtime.
navigation.title: Page
navigation.order: 242
navigation.group: Capabilities
icon: i-lucide-mouse-pointer-click
---

`page()` lets an Agent work the page the person has open. The page runs [ui-sdk's agent bridge](https://ui-sdk.dev/docs/agents/connect-an-agent), `createAgent()`. The Agent gets its three methods as tools, and each call goes over [Realtime](/docs/realtime/server-api#requests-to-a-browser) to that browser tab:

| Tool | What it does |
| --- | --- |
| `page_snapshot` | Lists the page's components with their state and the actions each takes. |
| `page_query` | Finds components and list items, such as the regions of a select, without listing the page. |
| `page_act` | Runs steps through each component's api, such as `setValue` on a select or `press` on Save. |

The descriptions are ui-sdk's own. Every change reaches the component's `on<Key>Change` with `source: "agent"`, so the page can tell the Agent's changes from the person's.

## Connect a page

Turn on Agents and Realtime. A Node build keeps its rooms in memory in one process:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ agent: true, realtime: true })],
})
```

Give the Agent the Capability and a web chat:

```ts [server/agents/settings.ts]
import { defineAgent } from 'vite-hub/agent'
import { page } from 'vite-hub/agent/capabilities'
import { webChat } from 'vite-hub/agent/channels'

export default defineAgent({
  capabilities: [page()],
  channels: { web: webChat() },
  driver: { model: 'openai/gpt-5' },
})
```

On the page, create the ui-sdk bridge, connect it, and hand it to the chat:

```vue [app/components/Assistant.vue]
<script setup lang="ts">
import { createAgent } from '@ui-sdk/vue/agent'
import { connectPage } from 'vite-hub/agent/page'
import { useAgent, useChat } from 'vite-hub/agent/vue'

const chat = useChat(useAgent('settings'), { page: connectPage(createAgent()) })
</script>
```

`connectPage()` joins a Realtime room named by a random id for this page load. `useChat()` sends the id in the `x-vitehub-page` header of each chat request and waits until the page joined its room. `page()` reads the header, so the Agent works the tab that sent the message.

Without Vue, or when a route starts the Agent, send `page.headers` yourself. `page()` reads the header from the request of the run:

```ts fragment
const page = connectPage(createAgent())
await page.ready
await fetch('/api/fix-settings', { method: 'POST', headers: page.headers })
```

A run without a request, such as one that a queue starts, names the page in its context: `startAgentInvocation(agent, runtime, { prompt, context: { page: { id } } })`.

## When the page is gone

A run without a page gets no page tools. When the page closes, reloads, or does not answer, the tool returns `{ ok: false, code, error }` instead of failing the run, so the model can tell the person:

| `code` | When |
| --- | --- |
| `REALTIME_ROOM_EMPTY` | The tab closed, or did not join within 5 seconds. A reload makes a new page id, so the run cannot reach the new tab. |
| `REALTIME_ROOM_TIMEOUT` | The page did not answer: 30 seconds for `page_snapshot` and `page_query`, 330 seconds for `page_act`. |
| `REALTIME_ROOM_CROWDED` | Two browsers joined the same page room. |
| `REALTIME_ROOM_ELSEWHERE` | On Node with Redis or Postgres, the tab is connected to another instance. |

`page({ timeout, actTimeout })` changes the two limits. `page_act` waits longer because a step inside `data-agent-confirm` waits up to 5 minutes for the person.

## Who decides each step

The page decides. The bridge's own `allow` runs for every step that `page_act` asks for, in the browser, before the step runs:

```ts fragment
const bridge = createAgent({
  allow: step => step.confirm ? window.confirm(step.confirm) : true,
})
```

Without `allow`, a step on an element inside `data-agent-confirm` fails with "Needs a person", and the model reads that answer. Values inside `data-agent-secret` and secret fields read `[redacted]` before they leave the page.

> [!WARNING]
> The page id is the only key to the room. Anyone who knows it can join the room and answer, or send it with a chat request. ViteHub makes it random for each page load and keeps it out of the tool metadata. Keep it out of URLs. Binding the room to the signed-in person is not in place yet.

## Inspect calls

Each call is a tool call of the run. The Invocation journal records it as `agent.tool.start` and `agent.tool.finish` with `capability.id: "page"` and the tool name, so `vitehub agent invocations show <id>` lists every page call like other Capability calls. A journal that keeps content also records the title ("Read the page", "Searched the page", "Changed the page"), the input, and the result. `inspectAgentTools()` lists the three tools, and the Capability metadata names the Realtime Definition, `agent-pages`, that ViteHub adds when an app has Agents and Realtime.

## Limits

- One page is one tab: a duplicated tab gets its own id.
- The Agent reaches pages through the Realtime room authority. On Node with Redis or Postgres, the tab and the run must use the same instance.
- An answer over 1 MiB fails with `REALTIME_ROOM_REFUSED`. ui-sdk stops a long `page_snapshot` at 100 components.
