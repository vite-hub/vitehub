---
title: Harness
description: Choose a model-aware agent runtime, then surround it with Skills and explicit ViteHub execution boundaries.
navigation.order: 22.25
icon: i-lucide-orbit
---

A model provides inference. A harness turns that model into an agent by coordinating its loop, tool protocol, permissions, sessions, context management, and execution surfaces.

For autonomous work over files, commands, and tools, start with the model vendor's harness when ViteHub has an adapter. Use a model-backed Agent Driver when the task is narrow enough that ViteHub's model execution and tool loop are the simpler boundary.

![A dark model core held by a yellow harness, with four Skill modules attached and distinct Workspace, Box, and Sandbox modules around the outer environment.](/images/tutorials/harness-layers-flat.png)

## Understand the layers

The layers compose from the model outward. Each one owns a different part of the runtime, so changing the model does not require folding files, permissions, or execution policy into the prompt.

| Layer | What it owns |
| --- | --- |
| Model | Generates model output and tool-call decisions from the input it receives. |
| Harness | Runs the agent loop around the model, including model-specific tools, sessions, context management, and permission behavior. |
| Skills | Add reusable procedures and supporting files. Skills guide the harness, but they do not grant runtime authority by themselves. |
| Workspace | Supplies scoped file-tree state, Sources, rules, snapshots, and writeback. |
| Box | Prepares a harness process environment, private Home, working checkout, credentials, and boot requirements. |
| Sandbox | Selects the process or session environment for harness work. Isolation is provided only by an isolation-capable provider or the separate Sandbox primitive. |

ViteHub owns the composition boundary around these layers. An [Agent Driver](/docs/agents/agent-drivers) selects model-backed, harness-backed, or custom-run-backed execution, while Capabilities and Workspace policy decide which abilities and context the invocation receives.

## Prefer the matched harness

Model vendors tune their agent harnesses alongside their models. A matched harness can evolve its tool protocol, context compaction, approval behavior, session lifecycle, and model-specific prompting without every ViteHub application rebuilding that work.

ViteHub provides helpers for Codex and Claude Code through `codexDriver()` and `claudeCodeDriver()`. These helpers adapt the harness to ViteHub's Agent Driver, Workspace, Capability, inspection, and runtime-policy boundaries.

Build a custom harness only when the task needs a materially different agent loop or runtime contract. For a bounded transformation, classification, structured response, or small application-owned tool loop, a model-backed driver is usually the smaller surface.

| Choose | When |
| --- | --- |
| Harness-backed driver | The Agent should inspect files, run commands, use Skills, preserve a harness session, or operate inside a prepared environment. |
| Model-backed driver | The application owns a bounded interaction and ViteHub should run the model and its Capability-contributed tool loop directly. |
| Custom-run-backed driver | Developer code should own execution and decide whether to call a model or harness internally. |

## Compose a harness-backed Agent

Install the Agent Package and the harness adapter that matches the selected agent runtime:

```bash [Terminal]
pnpm add @vite-hub/agent @ai-sdk/harness @ai-sdk/harness-codex
```

Use the ViteHub driver helper, then attach Skills and Workspace context around it:

```ts [server/agents/review/agent.ts]
import { defineAgent } from '@vite-hub/agent'
import { skills } from '@vite-hub/agent/capabilities'
import { codexDriver } from '@vite-hub/agent/harness/codex'

export default defineAgent({
  driver: codexDriver(),
  workspace: {
    mode: 'write',
  },
  capabilities: [
    skills({ path: '.agents/skills/review' }),
  ],
})
```

The model remains inside Codex. The Harness Agent Driver adapts Codex to one Agent Invocation, `skills()` mounts the selected Skill into the Harness Workspace Session, and Workspace write mode controls whether session changes return to the Workspace.

## Keep environment boundaries explicit

Workspace, Box, and Sandbox surround harness execution for different reasons. They are complementary boundaries, not three names for the same container.

- Use [Workspace context](/docs/agents/workspace-context) for model-visible files, Sources, scope, and writeback.
- Use a [Box](/docs/agents/boxes) when the harness needs a prepared Home, environment, checkout, credentials, and executable checks. A trusted-host Box does not isolate untrusted code from the host.
- Use `driver.sandbox` when a harness-backed Agent needs a process-capable or provider-specific harness session. The default local provider is a tempdir-backed shell convenience, not OS/process isolation. The separate [Sandbox primitive](/docs/server-primitives/sandbox) owns named isolated application work, and the [Sandbox Capability](/docs/capabilities/sandbox) can expose allowlisted Sandbox commands to an Agent.

## Next steps

- Read [Agent Drivers](/docs/agents/agent-drivers) for the exact `model`, `harness`, and `run` contracts.
- Read [Skills](/docs/capabilities/skills) for Workspace and global Skill mounting.
- Read [Boxes](/docs/agents/boxes) before giving a harness a managed execution environment.
- Read [Workspace context](/docs/agents/workspace-context) for file visibility and writeback.
