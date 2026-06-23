---
title: Skills
description: Require a Workspace skill file for an Agent Invocation.
navigation.title: Skills
navigation.order: 60
navigation.group: Workspace
icon: i-lucide-scroll-text
---

`skills()` adds a Workspace requirement and model-facing hint for a skill file.
Use it when an Agent must have a `SKILL.md` file available before it runs.

## Installation

Import the Capability factory from `-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability records the configured skill path in metadata, requires the Workspace path to exist, and tells model-backed Agents where to read the full skill.
By default it does not expose model-facing tools beyond the instruction hint.
When `shellExecution` is set, it also exposes `skill_shell`, which runs commands from the mounted skill instructions through the active Workspace Session.
When `source` is set, ViteHub adds that source to the Agent Workspace at definition time and mounts it at the skill path.

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

Mount a remote skill source when the Agent should not carry the skill file in the local project:

```ts [server/agents/review/browser.ts]
import { defineAgent } from '@vite-hub/agent'
import { skills } from '@vite-hub/agent/capabilities'
import { github } from '@vite-hub/workspace'

export default defineAgent({
  driver: { model },
  workspace: { name: 'review', mode: 'write' },
  capabilities: [
    skills({
      path: 'skills/agent-browser',
      source: github({
        repo: 'vercel/vercel-plugin',
        root: 'skills/agent-browser',
        include: ['SKILL.md', 'references/**', 'templates/**'],
        materialize: 'build',
      }),
      shellExecution: 'write',
    }),
  ],
})
```

## Runtime behavior

ViteHub validates the Workspace read requirement before the Agent Driver runs.
The Capability metadata includes the directory path and the resolved `SKILL.md` path.
Generated instructions include the skill path, the frontmatter `name` and `description` when available, and a reminder to read the full `SKILL.md`.
With `shellExecution: 'write'`, successful `skill_shell` commands commit Workspace Session changes back into the Workspace.
With `source`, ViteHub still uses normal Workspace Source materialization, visibility, and DevTools metadata. `skills()` does not fetch source files at invocation time.

## Requirements

`skills()` requires an explicit Workspace with read access to the configured skill file.
The path can point to a directory or directly to a `SKILL.md` file.
When `source` is configured, `path` is the canonical mount. ViteHub mounts the source at the configured skill directory even when the source helper has its own default mount.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Validates the skill file requirement, receives the generated skill-read hint, and can read the mounted skill through Workspace tools. |
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
| `instructions` | `string \| false` | generated | Override or disable the generated skill-read instructions. |
| `path` | `string` | `"skills"` | Directory or `SKILL.md` path required in the Workspace. |
| `shellExecution` | `"read" \| "write"` | none | Optional Workspace Session shell execution mode for commands described by the mounted skill. |
| `source` | `WorkspaceSourceInput` | none | Workspace Source to mount at the skill directory. |
| `sourceKey` | `string` | derived from `path` | Workspace source key used when `source` is configured. |
| `timeout` | `number` | none | Default `skill_shell` timeout in milliseconds. |

## Reference

- [Workspace primitive](/docs/server-primitives/workspace)
- [Agent instructions](/docs/agents/instructions)
- Source: `packages/agent/src/capabilities/skills.ts`
