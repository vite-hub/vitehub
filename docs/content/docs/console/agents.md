---
title: Agents in the Console
description: Start Agent Invocations from the Console, read their context, usage, and Capabilities, cancel a run, and know which journal keeps them.
navigation.title: Agents
navigation.order: 11
navigation.group: Use the Console
icon: i-vitehub-agent
---

The **Agents** section lists your Agents and their sessions, where a **session** is one Agent Invocation in the app's journal. You can read what the model saw, cancel a run, or start a new one. The **Skills** and **Usage** sections read the same Agents.

## Start Agent Invocations

`console.invoke` lets the Console start Agent Invocations and run manual Schedules. It is on by default on the development server and off in a production build:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    console: { authorize: './server/console-authorize.ts', invoke: true },
  },
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
    vitehub({
      console: { authorize: './server/console-authorize.ts', invoke: true },
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
  plugins: [
    vitehub({
      console: { authorize: './server/console-authorize.ts', invoke: true },
    }),
  ],
})
```
:::
::


The caller also needs the `agents` section from `authorize`. `invoke: false` keeps inspection and turns off new invocations, and fixture mode always turns them off.

```ts
import { createMessage } from 'vite-hub/agent'
import type { ConsoleAgentInvocationInput } from 'vite-hub/console'

const body = {
  messages: [
    createMessage({ role: 'user', text: 'Which receipt date?' }),
    createMessage({ role: 'assistant', text: 'The promised date.' }),
  ],
  prompt: 'And if that is blank?',
} satisfies ConsoleAgentInvocationInput
```

`agents.invoke` takes an Agent name and a `ConsoleAgentInvocationInput`: a non-empty `prompt`, and optionally a configured `invokerProfileId` and earlier `messages`. History must be valid ViteHub Messages with `user` or `assistant` roles, unique IDs, and `text`, `file`, `image` or `audio` parts; anything else is rejected before the Agent starts. Each request creates a new invocation and never resumes an earlier runtime session.

### Attach images

With `console.invoke` on, one invocation takes up to ten PNG, JPEG, WebP or GIF images, 10 MiB in total. The Blob store must return an HTTP or relative serving URL. The Agent and invoker profile stay fixed while images upload, so switching Agents leaves the pending request with the first one. If storage or setup fails before the Agent takes the images, the Console rolls the uploads back. Images given to an Agent stay under `_vitehub/console/attachments/` and follow your Blob retention policy.

## Cancel a running session

**Cancel session** shows in the header of a pending or running session when you have `invoke` access to its Agent; otherwise `invocations.cancel` returns `403`. A run in the same process stops at once, and one in another process stops at its next claim renewal, within 10 seconds. When the Driver cannot stop the run, the header shows `Cancel requested, not enforced by <driver>` until the Driver returns. See [Cancel an invocation](/docs/agents/invocations#cancel-an-invocation) for each Driver.

A finished session shows **Abort stale execution**, which aborts any execution still registered in the server process and leaves the journal as it is. A journal that kept no pending or running request returns `503`.

When an Agent changed a person's page through the [page Capability](/docs/agents/capabilities/page), the session has a **Page** surface with each change: its label, the values before and after, the step, the page, the person and the time. **Undo** (`invocations.undo`) asks the open page to put one change back. It needs write access to Agents, works only while the page is open, and keeps a value that the person changed after the Agent.

## Inspect a session

| View | Shows | Reads |
| --- | --- | --- |
| **Captured setup** | What the model saw: the final instruction blocks and tools, with each tool's description and JSON Schemas, after the Agent Definition, Capabilities and runtime tools apply, so dynamic tools are included. | The trace. |
| **Capabilities** (right panel) | Each Capability's recorded data and tools. MCP groups tools by server with their original names and schemas, Title shows its settings, progress and result, and others get a default view. | The snapshots. |
| Session usage | The usage record of the invocation. | The finish event. |

A journal keeps metadata only by default, so Captured setup shows tool names without instructions, descriptions or schemas. Set `configuration: 'content'` on the Agent's journal to keep the context apart from other trace content; `content: 'content'` keeps it too. Every view marks data that is missing or cut at ViteHub's trace limits. You can [add a read-only Capability view](/docs/agents/capabilities/custom#contribute-an-inspection-view) with the shared JSON Render catalog.

::warning
This context can hold secrets or customer data from app code. Protect it like prompts and model output, with the same [access, retention and encryption controls](/docs/agents/invocation-storage#store-invocation-history).
::

## Skills and Usage

**Skills** shows the files bundled with each Agent Definition, from colocated `skills/` folders and `agentWithSkills()`, as a Markdown preview or source. It reads the current Definition, so it starts no invocation and refreshes no Source. Text previews stop at 512 KiB, and binary files have none. **Skill index** opens [ViteHub's published Skill index](https://vitehub.dev/.well-known/skills/index.json), not your app's; the skills that your app serves are in **Served skills**.

**Usage** shows the tokens and cost that providers reported for completed invocations over 24 hours, or 7, 30 or 90 days, by time and model. `usage.get` returns the same data. A warning shows when the scan reaches 10,000 records or a finish event is cut, so partial totals never look complete. The Console fills in nothing that the provider left out. Add the [Usage Capability](/docs/agents/capabilities/usage) for an explicit usage request, an estimated cost, or a typed Agent Usage Record at finish.

## Which journal the Console reads

The Console stores no invocations. It reads the app-wide journal of `@vite-hub/agent`, by default the [SQLite journal](/docs/agents/invocation-storage#use-the-default-journal) at `.vitehub/data/agent-invocations.sqlite`, which keeps invocation records and searchable text such as prompts, messages, final text, progress updates and session titles.

A journal from `defineAgent({ invocations })` or [`agent.invocations`](/docs/agents/invocation-storage#use-one-journal-for-every-agent) replaces it. The Console reads one combined journal, so every discovered Agent must use the same one, or setup fails. With `invocations: false` an Agent records no sessions, and `agent: { invocations: false }` leaves the Console with none.

In production, you still decide how long to keep records that can hold sensitive data. To build your own inspection page, use [UI parts](/docs/ui) such as [Trace](/docs/ui/trace), and see [Agent Invocations](/docs/agents/invocations) for custom stores.
