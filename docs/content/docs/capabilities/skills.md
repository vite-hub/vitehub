---
title: Skills
description: Require a Workspace skill file for an Agent Invocation.
navigation.title: Skills
navigation.order: 60
navigation.group: Workspace
icon: i-lucide-scroll-text
---

`skills()` makes a Workspace Skill file available to an Agent Invocation.
Use it when an Agent must have a `SKILL.md` file, and any files beside it, before it runs.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability records the configured Skill path in metadata and requires the Workspace path to exist.
When `shellExecution` is set, model-backed Agents receive the normal Workspace Shell tools in the requested mode.
When `source` is set, ViteHub adds that source to the Agent Workspace at definition time and mounts it at the skill path.

Direction: model-facing guidance for a Skill should be covered by Agent Driver Instructions or deterministic imported instruction Markdown. ViteHub should warn when `skills()` makes a Skill available but no explicit instruction coverage names it.

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
Current model-backed drivers may receive generated skill-read instructions, but new docs should prefer explicit Skill coverage in Agent Driver Instructions.
For harness-backed drivers, `skills()` contributes the skill directory to the Harness Workspace Session instead of adding model-facing instructions or tools.
With `shellExecution: 'write'`, model-backed Workspace Shell writes commit Workspace Session changes back into the Workspace.
With `source`, ViteHub still uses normal Workspace Source materialization, visibility, and DevTools metadata. `skills()` does not fetch source files at invocation time.

## Requirements

`skills()` requires an explicit Workspace with read access to the configured skill file.
The path can point to a directory or directly to a `SKILL.md` file.
When `source` is configured, `path` is the canonical mount. ViteHub mounts the source at the configured skill directory even when the source helper has its own default mount.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Validates the skill file requirement and can read the mounted Skill through Workspace tools when tools are available. |
| Harness-backed | Validates the skill file requirement and mounts the skill directory into the Harness Workspace Session. It does not receive generated skill instructions or Workspace Shell tools from `skills()`. |
| Custom-run-backed | Validates the skill file requirement before `driver.run`. |

## Inspect and verify

Run the Agent with the configured Workspace.
A missing skill file should fail before model execution with a Workspace path requirement error.

Inspect Capability metadata for the normalized `path` and `skillPath` values.
When coverage diagnostics land, a configured Skill should warn until Agent Driver Instructions or a deterministic imported instruction file explicitly covers it.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `instructions` | `string \| false` | generated | Current override for generated skill-read instructions. Prefer explicit Skill coverage in Agent Driver Instructions for new guidance. |
| `path` | `string` | `"skills"` | Directory or `SKILL.md` path required in the Workspace. |
| `shellExecution` | `"read" \| "write"` | none | Optional Workspace Shell mode for model-backed Agents. Harness-backed Agents still receive the skill files, not Workspace Shell tools. |
| `source` | `WorkspaceSourceInput` | none | Workspace Source to mount at the skill directory. |
| `sourceKey` | `string` | derived from `path` | Workspace source key used when `source` is configured. |

## Reference

- [Workspace primitive](/docs/server-primitives/workspace)
- [Agent instructions](/docs/agents/instructions)
- Source: `packages/agent/src/capabilities/skills.ts`
