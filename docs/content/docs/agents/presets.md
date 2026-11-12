---
title: Agent presets
description: Start from a reusable Agent Definition and configure it for your application.
navigation.title: Overview
navigation.order: 90
navigation.group: Presets
icon: i-lucide-copy
navigation.kind: Guides
---

An Agent preset is a ready Agent Definition with defaults, instructions, and behavior. You pick a preset and add your model, credentials, and project settings.

Import ready presets from `vite-hub/presets/<name>` (package `@vite-hub/presets`). They use ViteHub primitives such as Channels, Capabilities, and process hosts.

## Choose a preset

| Preset | Use it for | Host requirements |
| --- | --- | --- |
| [Babysitter](/docs/agents/babysitter) | Fix pull requests, answer reviews, wait for checks, and optionally merge. | A persistent Node process, SQL Agent State, Git, a GitHub App, and Codex or Claude Code. |
| [Workspace](/docs/agents/workspace-preset) | Read mounted Sources and cite files at their resolved GitHub revision. | A configured Workspace and the Codex Driver. |

The deployment `preset` in `vitehub({ preset: 'node' })` is different. It picks the server host, not an Agent workflow.

## Select and configure

Import a preset and pass it as `extends`. The Agent inherits the preset and overrides only the options you set.

```ts [server/agents/babysitter/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { babysitter } from 'vite-hub/presets/babysitter'

export default defineAgent({
  extends: babysitter,
  workspace: {},
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

An Agent file alone is not enough. Babysitter also needs [GitHub setup](/docs/agents/babysitter#configure-github), [deployment](/docs/agents/babysitter#deploy), and [label controls](/docs/agents/babysitter#control-work-with-labels).

You can also pick one parent with `extends: babysitter`. Use `extends` or `preset`, not both. Preset names are local to the definition. ViteHub does not load packages by name and has no global preset registry.

## Customize the Agent

Put workflow settings in `options` and provider settings in `driver`. For example, Babysitter's `options.driver` picks Codex or Claude Code, and `driver.model` picks the model.

If a preset has an instruction slot, put `instructions.md` next to `agent.ts`. Your guidance fills the slot, and the preset keeps its workflow instructions. Read [Instructions](/docs/agents/instructions) before you replace a whole instruction template.

When you extend a preset:

- The extension gets a fresh runtime.
- Capabilities and Channels with the same key replace inherited ones.
- A hook with the same name runs after the inherited hook.
- Other arrays and option callbacks replace inherited ones.

See [Agent presets and inheritance](/docs/agents/agent-presets#extend-an-agent) for the full rules.

## Share your own preset

Export a `defineAgent()` definition. If users need workflow settings, add typed `options` and a synchronous `configure` callback. Keep credentials and network calls out of that callback.

Publishers must declare `@vite-hub/agent` as a peer dependency and include instruction content and required assets explicitly. Selecting a preset does not discover files inside its package. See [Presets from a package](/docs/agents/agent-presets#presets-from-a-package) for the authoring API.

A preset that needs a long-running Node host attaches one with `withAgentProcessHost()` from `vite-hub/agent/process`. List the preset subpath in the `vitehub.agent.processHost` field of your package.json, so that ViteHub starts the host and rejects hosts that cannot run it. List subpaths that select the Codex or Claude Code Driver in `vitehub.agent.providerDriver`, so that Worker builds fail early:

```json [package.json]
{
  "vitehub": {
    "agent": {
      "processHost": ["./babysitter"],
      "providerDriver": ["./babysitter", "./workspace"]
    }
  }
}
```
