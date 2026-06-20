---
title: skills()
description: Require a Workspace skill file for an Agent Invocation.
navigation.title: skills()
navigation.order: 60
icon: i-lucide-scroll-text
---

`skills()` adds a Workspace requirement for a skill file.
Use it when an Agent must have a `SKILL.md` file available before it runs.

## What it adds

The Capability records the configured skill path in metadata and requires the Workspace path to exist.
It does not expose model-facing tools by itself.

## Minimum attach example

The default path is `skills/SKILL.md`.
Pass a custom path when the Workspace stores the skill somewhere else.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { skills } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    skills(),
  ],
})
```

## Runtime behavior

ViteHub validates the Workspace read requirement before the Agent Driver runs.
The Capability metadata includes the directory path and the resolved `SKILL.md` path.

## Requirements

`skills()` requires an explicit Workspace with read access to the configured skill file.
The path can point to a directory or directly to a `SKILL.md` file.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Validates the skill file requirement; reading or rendering the file remains Agent or Workspace behavior. |
| Harness-backed | Validates the skill file requirement before harness execution. |
| Custom-run-backed | Validates the skill file requirement before `driver.run`. |

## Inspect and verify

Run the Agent with the configured Workspace.
A missing skill file should fail before model execution with a Workspace path requirement error.

Inspect Capability metadata for the normalized `path` and `skillPath` values.

## Reference

- [Workspace primitive](/docs/server-primitives/workspace)
- [Agent instructions](/docs/agents/instructions)
- Source: `packages/agent/src/capabilities/skills.ts`
