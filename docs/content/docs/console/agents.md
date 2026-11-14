---
title: Agents in the Console
description: Start Agent Invocations from the Console, read their context, usage, and Capabilities, cancel a run, and know which journal keeps them.
navigation.title: Agents
navigation.order: 11
navigation.group: Use the Console
icon: i-vitehub-agent
---

The **Agents** section lists discovered Agents and their sessions. Each session is an Agent Invocation that the app's journal keeps. The **Skills** and **Usage** sections read the same Agents.

## Start Agent Invocations

`invoke` lets the Console start Agent Invocations and run manual Schedules. It is `true` on the development server and `false` in a production build by default:

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

The invocation operations call `authorize`, so it decides who can start invocations. A user also needs the `agents` section. `invoke: false` keeps inspection and turns off new invocations. Fixture mode always turns them off.

The `agents.invoke` operation takes an Agent name and the fields of `ConsoleAgentInvocationInput` from `vite-hub/console`: a non-empty `prompt`, and optionally a configured `invokerProfileId` and earlier `messages`.

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

History must hold valid ViteHub Messages with `user` or `assistant` roles, unique IDs, and `text`, `file`, `image`, or `audio` parts. The Console adds the prompt as a user Message. It rejects bad Messages, `system` or `tool` roles, and other parts before the Agent starts. Each request creates a new invocation and does not resume an earlier runtime session.

### Attach images

Image uploads need `console.invoke`. The Agent and invoker profile that you chose at submit stay fixed while images upload. If you switch Agents, the pending request stays with the first Agent.

- Images must be PNG, JPEG, WebP, or GIF: at most ten images and 10 MiB in total per invocation.
- Blob storage must return an HTTP or relative serving URL.
- If storage or setup fails before the Agent takes the images, the Console rolls back the uploads.
- Images given to an Agent stay under `_vitehub/console/attachments/` and follow your Blob retention policy.

## Cancel a running session

A pending or running session shows **Cancel session** in its header when the Console has `invoke` access for its Agent. Without it, the button is hidden and `invocations.cancel` returns 403.

The Console calls `invocations.cancel(id)` on the Agent's journal. A run in the same process stops at once. A run in another process sees the request at its next claim renewal, within 10 seconds. When the Driver (the code that runs the Agent) cannot stop the run, the header shows `Cancel requested, not enforced by <driver>`, and the session runs until the Driver returns. See [Cancel an invocation](/docs/agents/invocations#cancel-an-invocation) for each Driver.

A finished session shows **Abort stale execution**. It sends an abort signal to any execution still registered in the server process, without changing the journal. A journal that did not keep a pending or running request returns 503.

A session in which an Agent changed a person's page through the [page Capability](/docs/agents/capabilities/page) has a **Page** surface: each change with its label, the values before and after, the step, the page, the person, and the time. **Undo** asks the person's open page to put one change back, through `invocations.undo`. It needs write access to the Agents section, works only while the page is open, and keeps a value that the person changed after the Agent.

## Inspect a session

| View | Shows | Reads |
| --- | --- | --- |
| **Captured setup** | The context of that run: the final instruction blocks and the tools that the model sees, with each tool's description and input and output JSON Schemas. It is the result after the Agent Definition, Capabilities, and runtime tools apply, so it covers dynamic tools too. | The invocation's trace. |
| **Capabilities** (right panel tab chooser) | The recorded data and tools of each Capability. MCP groups tools by server with their original names and schemas. Title shows its settings, progress, and result. Other Capabilities get a default tools and configuration view. | The invocation's snapshots. It does not run MCP discovery or title generation. |
| Session usage | The usage record of one invocation. | The finish event. |

Invocation journals keep metadata only by default. Then Captured setup has tool names but no instructions, descriptions, or schemas. Set `configuration: 'content'` on the Agent's journal to keep the context apart from other trace content. `content: 'content'` also keeps it. Large observations stay inside ViteHub's trace limits and are marked when cut. Missing or cut data is marked in every view.

You can [add a read-only Capability view](/docs/agents/capabilities/custom#contribute-an-inspection-view) with the shared JSON Render component catalog.

> [!WARNING]
> This context can contain secrets or customer data from app code. Protect it like prompts and model output, with the same access, retention, and encryption controls. See [Agent Invocations](/docs/agents/invocation-storage#store-invocation-history).

## Skills and Usage

**Skills** shows the files bundled with each Agent Definition: colocated `skills/` files and Skills added with `agentWithSkills()`. Select a file to read its Markdown preview or source. Links to other bundled files open them in the tree. It reads the current Agent Definition. It does not start an invocation or refresh a Source. Text previews stop at 512 KiB. Binary files are listed without a preview.

**Skill index** opens [ViteHub's published Skill index](https://vitehub.dev/.well-known/skills/index.json), which is not your app's Skills. The skills that your app serves to coding agents are in **Served skills**.

**Usage** shows the tokens and cost that providers report for the past 24 hours, 7 days, 30 days, or 90 days. It groups completed Agent Invocations by time and model. A warning shows when the scan reaches 10,000 records or a finish event is cut, so partial totals never look complete. The `usage.get` operation returns the same data.

The Console does not fill in missing provider data. Token counts, model metadata, and cost stay empty when the provider does not report them. Add the [Usage Capability](/docs/agents/capabilities/usage) when the provider needs an explicit usage request, estimated cost, or a typed Agent Usage Record at finish.

## Which journal the Console reads

The Console does not store Agent Invocations. It reads the app-wide journal that `@vite-hub/agent` installs, with the Console on or off. When Agents are configured and no journal is set, that is the default journal at `.vitehub/data/agent-invocations.sqlite`. It keeps invocation records and selected searchable text, including prompts, messages, final text, progress updates, and generated session titles. See [the default journal](/docs/agents/invocation-storage#use-the-default-journal) for its options, location, and retention.

A journal from `defineAgent({ invocations })` or from the app-wide `agent.invocations` option replaces the default journal. The Console reads that journal instead. An Agent with `invocations: false` records no sessions. With `agent: { invocations: false }`, the Console lists no sessions. Configure the same journal on every discovered Agent, or set [`agent.invocations`](/docs/agents/invocation-storage#use-one-journal-for-every-agent). Distinct journals fail during runtime setup, because the Console reads one combined journal.

In production, the operator must still decide how long to keep records that can contain sensitive data.

To build your own inspection page, use [UI parts](/docs/ui) such as [Trace](/docs/ui/trace) and [Code block](/docs/ui/code-block). See [Agent Invocations](/docs/agents/invocations) for custom stores and the invocation lifecycle.
