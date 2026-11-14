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

Turn on Agents and Realtime. This Node build keeps its rooms in memory, in one process:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', agent: true, realtime: { authority: 'memory' } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ host: 'node', agent: true, realtime: { authority: 'memory' } }),
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
  plugins: [
    vitehub({ host: 'node', agent: true, realtime: { authority: 'memory' } }),
  ],
})
```
:::
::

On Cloudflare, `realtime: true` keeps the rooms in a Durable Object.

Give the Agent the Capability and a web chat. With [Auth](/docs/auth), `authenticated()` tells `page()` who the person is:

```ts [server/agents/settings.ts]
import { defineAgent } from 'vite-hub/agent'
import { page } from 'vite-hub/agent/capabilities'
import { webChat } from 'vite-hub/agent/channels'
import { authenticated } from 'vite-hub/auth/agent'

export default defineAgent({
  invoker: authenticated(),
  capabilities: [page({
    deny: [{ label: 'Project name' }],
    requireApproval: [{ label: 'Save changes' }],
  })],
  channels: { web: webChat() },
  driver: { model: 'openai/gpt-5' },
})
```

On the page, pass ui-sdk's `createAgent` to `connectPage()`, and hand the page to the chat:

```vue [app/components/Assistant.vue]
<script setup lang="ts">
import { createAgent } from '@ui-sdk/vue/agent'
import { connectPage } from 'vite-hub/agent/page'
import { useAgent, useChat } from 'vite-hub/agent/vue'
import { connectRealtimeRoom } from 'vite-hub/realtime/client'

const page = connectPage(createAgent, {
  join: connectRealtimeRoom,
  allow: step => step.confirm ? window.confirm(step.confirm) : true,
})
const chat = useChat(useAgent('settings'), { page })
</script>
```

`connectPage()` makes the bridge itself, with `createAgent({ allow })`, so it can apply the server's rules to each step. `page.agent` is that bridge. For more ui-sdk options, pass a function: `connectPage(options => createAgent({ ...options, timeout: 60_000 }), { join })`. `connectPage()` joins a Realtime room named by a random id for this page load. It takes `connectRealtimeRoom` as `join` because the Agent package does not load Realtime itself. `useChat()` sends the id in the `x-vitehub-page` header of each chat request and waits until the page joined its room. `page()` reads the header, so the Agent works the tab that sent the message.

Without Vue, or when a route starts the Agent, send `page.headers` yourself. `page()` reads the header from the request of the run:

```ts fragment
const page = connectPage(createAgent, { join: connectRealtimeRoom })
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

`page({ timeout, actTimeout })` changes the two limits. `page_act` waits longer because a step that needs the person waits up to 5 minutes for their answer.

## Who decides each step

The developer decides, on the server, with two lists of rules:

| Option | A step it matches |
| --- | --- |
| `deny` | Never runs. `page_act` returns `AGENT_R1047`, and nothing of that step changes. |
| `requireApproval` | Runs only after the person approves it on the page. |

A rule names a component: `label` (compared without case or accents), `component` (its kind, like `select` or `button`), or `confirm: true` (an element inside `data-agent-confirm`). Every field a rule sets must match. A rule covers every action on its component, so a step cannot pass it with another action, another argument, or the component's ref id from a snapshot. Rules match page text, so a changed label stops matching: mark the element with `data-agent-confirm` and use `{ confirm: true }` for what must never slip. In development, the page warns in the console when a label rule matches nothing on the page.

With rules present, press a registered button directly. Container presses (for example, pressing a named button through a dialog) are refused with `AGENT_R1047`, because the current ui-sdk hook does not identify the descendant target.

The page applies the rules. ui-sdk resolves each step to its component first, then calls the `allow` that `connectPage()` gave it:

1. A `deny` match is refused.
2. A `requireApproval` match, or a step inside `data-agent-confirm`, goes to the page's own `allow` with `step.confirm` set to what the person is asked. Without an `allow`, the step fails with `AGENT_R1048`. When the person says no, it fails with `AGENT_R1049`.
3. Any other step goes to the page's own `allow`, which can refuse it too, or runs.

ui-sdk runs one call at a time, so while a step waits for the person, the Agent cannot press the approval itself. `page_act` waits up to 330 seconds for the answer. Each request carries the rules, and the page answers with the version of the rules it applied, so an old page client fails with `AGENT_R1050` instead of running steps unchecked.

The rules stop changes. They do not hide values: `page_snapshot` still reads a denied field. Use `data-agent-hidden` to hide a component, and `data-agent-secret` to send `[redacted]` in place of its value.

## Whose page it is

The Realtime room of a page belongs to the person who opened it. ViteHub keys the room by the signed-in [Auth](/docs/auth) user of the tab that joins it, so the same page id for two people is two rooms. `page()` asks only the room of the run's own person, the Auth user that `authenticated()` records on the Invoker:

- A second person who learns the page id and joins it lands in their own room, and gets none of the Agent's calls.
- A second person who starts a run with someone else's page id reaches their own empty room: `REALTIME_ROOM_EMPTY`.

> [!WARNING]
> Without Auth, or with an Invoker that is not `authenticated()`, every visitor shares one anonymous scope. Then the page id is the only key: a random 122-bit id for each page load, sent only to the app's own origin, in the `x-vitehub-page` header and the WebSocket URL. Anyone who learns it can join the room and answer, or name it in a chat request. Keep it out of URLs and logs, and use Auth for pages with private data.

A tab joins its room when it loads. A tab that signs in without a reload stays in the anonymous scope until it reloads. The Capability metadata says `binding: "user"`, so `inspectAgentTools()` shows it.

## How the person stops it

- The chat's Stop button (`chat.stop()`) cancels the run, and with it the page call that waits.
- `page.close()` leaves the room. Every later page call returns `REALTIME_ROOM_EMPTY`.
- Closing the tab does the same.

## Every change, and undo

The page records each change the Agent makes, with the value before and after. `page.changes()` lists them, oldest first, and `page.onChange(listener)` tells when the list changes:

```ts fragment
const page = connectPage(createAgent, { join: connectRealtimeRoom })
page.onChange(() => console.log(page.changes()))
// [{ id: 'chg_…', ref: 'c3', label: 'Default region', key: 'value', before: 'iad', after: 'fra', step: 0, at: '…' }]
const notRestored = await page.undo() // every change not undone yet, newest first
```

`page.undo(id)` puts back one change. Undo puts a value back only while the field still shows the Agent's value, so a person's later edit stays. It resolves the changes it could not put back.

| Undo covers | Undo does not cover |
| --- | --- |
| The values the Agent set: `value`, `checked`, `pressed` | What a press did on the server, like a save, a delete, or an email |
| Changes on the page that is still open | A page that was closed or reloaded |
| | A private field: its values read `[redacted]` |
| | A field a person changed after the Agent |

The server records each change in the Invocation journal as `agent.page.change`, with the page id, the person (`page.user`, the Auth user id or `anonymous`), the step, the label and key, and the time. The values before and after are in `page.change.content`, which follows the journal's content policy: the default journal keeps them, and another journal with `content: 'metadata'` keeps them only with `metadataContent: ['page.change.content']`. Each approval the page asked for is recorded as `agent.approval.request` and `agent.approval.decision`.

- `vitehub agent invocations show <id>` prints the page changes. With `--json`, they are in `pageChanges`, and the approvals in `approvals`.
- The Console shows them on the **Page** surface of the session, with an Undo button for each.
- `vitehub invocations undo <id> --change <change>` asks the person's open page to put one change back, as the Console's Undo does. It sends no value: the page restores from its own record, with the same rules as `page.undo(id)`. The journal records `agent.page.undo` with who asked.

## Inspect calls

Each call is a tool call of the run. The Invocation journal records it as `agent.tool.start` and `agent.tool.finish` with `capability.id: "page"` and the tool name. A journal that keeps content also records the title ("Read the page", "Searched the page", "Changed the page"), the input, and the result. `inspectAgentTools()` lists the three tools, and the Capability metadata names the Realtime Definition, `agent-pages`, the rules, and the binding.

## Security model

- **What a server Agent may do:** read the page through ui-sdk, where `data-agent-hidden` stays hidden and secrets read `[redacted]`, and run steps through each component's api, with `source: "agent"`. It cannot run code in the page, read the DOM, or reach a component that ui-sdk does not register.
- **Who decides:** the developer, with `page({ deny, requireApproval })` on the server. The page applies those rules to each resolved step. The page's own `allow` can only refuse more.
- **Who approves:** the person on the page, through the page's `allow`.
- **Whose page:** the signed-in person who opened it. Without Auth, whoever has the page id.
- **How it stops:** Stop in the chat, `page.close()`, or closing the tab.
- **What is recorded:** every change, with the Agent, the Invocation, the page, the person, the step, the values before and after, and the time, and every approval.

## Limits

- One page is one tab: a duplicated tab gets its own id.
- The Agent reaches pages through the Realtime room authority. On Node with Redis or Postgres, the tab and the run must use the same instance.
- An answer over 1 MiB fails with `REALTIME_ROOM_REFUSED`. ui-sdk stops a long `page_snapshot` at 100 components.
