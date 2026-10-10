---
title: Agent presets
description: Start from a reusable Agent Definition and configure it for your application.
navigation.title: Overview
navigation.order: 91
navigation.group: Presets
icon: i-lucide-copy
---

An Agent preset is a reusable Agent Definition. It supplies defaults, instructions, and behavior. Your application selects the preset and supplies its model, credentials, and project settings.

## Choose a preset

| Preset | Use it for | Host requirements |
| --- | --- | --- |
| [Babysitter](/docs/agents/babysitter) | Repair pull requests, address reviews, wait for checks, and optionally merge. | A persistent Node process, SQL Agent State, Git, a GitHub App, and Codex or Claude Code. |
| [Workspace](/docs/agents/workspace-preset) | Read mounted Sources and cite files at their resolved GitHub revision. | A configured Workspace and the Codex Driver. |

These are Agent presets. The deployment `preset` in `vitehub({ preset: 'node' })` selects the server host; it does not select an Agent workflow.

## Select and configure

Import a preset and give it a name in the Agent's local `presets` map. The `preset` field selects that name.

```ts [server/agents/babysitter/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { babysitter } from 'vite-hub/agent/presets/babysitter'

export default defineAgent({
  preset: 'babysitter',
  presets: { babysitter },
  options: {
    filter: { repository: { allow: ['acme/app'] } },
    lifecycle: {
      labels: { require: ['agent:repair'], deny: ['agent:paused'] },
    },
    merge: false,
  },
  driver: { model: 'your-codex-model' },
})
```

The Babysitter guide covers [GitHub setup](/docs/agents/babysitter#configure-github), [deployment](/docs/agents/babysitter#deploy), and [label controls](/docs/agents/babysitter#control-work-with-labels). Adding an Agent file alone does not supply these prerequisites.

You can also select one parent with `extends: babysitter`. Use either `extends` or `preset` in one definition. Preset names stay local to the definition; ViteHub does not load packages by name or create a global preset registry.

## Customize the Agent

Set workflow settings in `options` and provider settings in `driver`. For example, Babysitter's `options.driver` selects Codex or Claude Code, while `driver.model` selects that provider's model.

For presets with an instruction slot, place `instructions.md` beside `agent.ts` to supply project guidance. This fills the slot while keeping the preset's workflow instructions. See [Instructions](/docs/agents/instructions) before replacing an entire instruction template.

An extension gets a fresh runtime. Matching Capabilities, Channels, and hooks replace inherited entries by their keys. Other arrays replace inherited arrays, and option callbacks replace inherited callbacks. See [Agent Definitions](/docs/agents/agent-definitions#extend-an-agent) for the composition rules.

## Share your own preset

Export a definition created with `defineAgent()`. Add typed `options` and a synchronous `configure` callback when consumers need workflow settings. Keep credentials and network calls out of that callback.

Publishers must declare `@vite-hub/agent` as a peer dependency and include instruction content and required assets explicitly. Selecting a preset does not discover files inside its package. See [Named presets](/docs/agents/agent-definitions#named-presets) for the authoring API.
