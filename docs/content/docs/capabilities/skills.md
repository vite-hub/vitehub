---
title: Skills
description: Require a Workspace skill file for an Agent Invocation.
navigation.title: Skills
navigation.order: 60
navigation.group: Workspace
icon: i-lucide-scroll-text
---

`skills()` adds a Workspace requirement for a skill file.
Use it when an Agent must have a `SKILL.md` file available before it runs.

## Installation

Import the Capability factory from `-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability records the configured skill path in metadata and requires the Workspace path to exist.
By default it does not expose model-facing tools.
When `shellExecution` is set, it also exposes `skill_shell`, which runs commands from the mounted skill instructions through the active Workspace Session.

## Configuration

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
With `shellExecution: 'write'`, successful `skill_shell` commands commit Workspace Session changes back into the Workspace.

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

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxOutputLength` | `number` | `30000` | Maximum stdout/stderr characters returned from `skill_shell`. |
| `path` | `string` | `"skills"` | Directory or `SKILL.md` path required in the Workspace. |
| `shellExecution` | `"read" \| "write"` | none | Optional Workspace Session shell execution mode for commands described by the mounted skill. |
| `timeout` | `number` | none | Default `skill_shell` timeout in milliseconds. |

## Reference

- [Workspace primitive](/docs/server-primitives/workspace)
- [Agent instructions](/docs/agents/instructions)
- Source: `packages/agent/src/capabilities/skills.ts`
