---
title: Agent presets
description: Start from a ready-made Agent Definition, such as Babysitter or the Workspace preset, and configure it for your application.
navigation.title: Overview
navigation.order: 1
icon: i-lucide-copy
---

An Agent preset is a ready Agent Definition with defaults, instructions, and behavior. You pick a preset, add your model and credentials, and set your project options.

Import presets from `vite-hub/presets/<name>`, provided by `@vite-hub/presets`. They use ViteHub primitives such as Channels, Capabilities, and process hosts.

## Choose a preset

| Preset | Use it for | Host requirements |
| --- | --- | --- |
| [Babysitter](/docs/presets/babysitter) | Fix pull requests, reply to reviews, wait for checks, and optionally merge. | A persistent Node process, SQL Agent State, Git, a GitHub App, and Codex or Claude Code. |
| [Workspace](/docs/presets/workspace) | Read mounted Sources and cite files at their resolved GitHub revision. | A configured Workspace and the Codex Driver. |
| [Gmail Labeller](/docs/presets/labeller) | Label Gmail messages with ordered rules, and let Jev pick a label when no rule matches. | A [Gmail Channel](/docs/agents/gmail) and a Jev provider. |

The deployment `host` option in `vitehub({ host: 'node' })` is different. It picks your server host, not an Agent workflow.

## Select and configure

Import a preset and pass it to `extends`. Your Agent inherits the preset and overrides only what you set.

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

An Agent file alone is not enough. Babysitter also needs [GitHub setup](/docs/presets/babysitter#configure-github), [deployment](/docs/presets/babysitter#deploy), and [label controls](/docs/presets/babysitter#control-work-with-labels).

`extends` takes one parent Agent Definition that you import. `defineAgent()` has no `preset` or `presets` option and throws `AGENT_PRESET_OPTION_UNSUPPORTED` if you pass one. ViteHub does not load packages by name and has no global preset registry.

## Customize the Agent

Put workflow settings in `options` and provider settings in `driver`. For example, Babysitter's `options.driver` picks Codex or Claude Code, and `driver.model` picks the model.

When a preset has an instruction slot, put `instructions.md` next to `agent.ts`. Your file fills the slot, and the preset keeps its workflow instructions. Read [Instructions](/docs/agents/instructions) before you replace a whole instruction template.

When you extend a preset:

- The child Agent gets a fresh runtime.
- Capabilities and Channels with matching keys replace inherited ones.
- A hook with the same name runs after the inherited hook.
- Other arrays and option callbacks replace inherited ones.

See [Agent presets and inheritance](/docs/agents/agent-presets#extend-an-agent) for the full rules.

## Share your own preset

Export a `defineAgent()` definition. If users need workflow settings, add typed `options` and a synchronous `configure` callback. Keep credentials and network calls out of `configure`.

Declare `@vite-hub/agent` as a peer dependency and include instruction content and required assets explicitly. Selecting a preset does not discover files inside its package. See [Presets from a package](/docs/agents/agent-presets#presets-from-a-package) for the authoring API.

If a preset needs a long-running Node host, attach one with `withAgentProcessHost()` from `vite-hub/agent/process`. List the preset subpath in the `vitehub.agent.processHost` field of your `package.json`, so ViteHub starts the host and rejects hosts that cannot run it:

```json [package.json]
{
  "vitehub": {
    "agent": {
      "processHost": ["./babysitter"]
    }
  }
}
```
