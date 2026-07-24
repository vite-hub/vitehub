---
title: Skills
description: Mount skill files into an Agent Workspace or harness profile.
navigation.title: Skills
navigation.order: 60
navigation.group: Workspace
icon: i-lucide-scroll-text
---

`skills()` makes a Workspace or external Source Skill available to an Agent Invocation. Workspace scope is the default; global scope mounts a source into the harness profile so Codex can discover it as an installed Skill.

For an Agent-owned Skill, use a folder Agent Definition whose entry file is named `agent.ts`, `agent.js`, `index.ts`, or `index.js`, including their `c` and `m` variants, then place `skills/` beside that entry file. ViteHub discovers and materializes those files automatically, so local Skills do not need a Capability declaration. Flat files such as `server/agents/support.ts` do not discover sibling Skills.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })` when the Skill is supplied by a Workspace or external Source.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability records the configured Skill path in metadata and requires the Workspace path to exist.
When `shellExecution` is set, model-backed Agents receive the normal Workspace Shell tools in the requested mode.
When `source` is set, ViteHub adds that source to the Agent Workspace at definition time and mounts it at the skill path.
With `scope: 'global'`, ViteHub mounts the source into the harness's global Skill directory instead. Global scope requires a source and does not require an Agent Workspace.

Model-facing guidance for a Skill belongs in Agent Driver Instructions or deterministic imported instruction Markdown. Agent inspection metadata warns when `skills()` makes a Skill available but no explicit instruction coverage names it.

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

Install a Skill into the isolated Codex profile when Codex should discover it globally without adding it to the project Workspace:

```ts [server/agents/review.ts]
import { defineAgent } from '@vite-hub/agent'
import { skills } from '@vite-hub/agent/capabilities'
import { github } from '@vite-hub/workspace'

export default defineAgent({
  driver: 'codex',
  capabilities: [
    skills({
      path: 'skills/ponytail',
      scope: 'global',
      source: github({ repo: 'onmax/ponytail', root: 'skills/ponytail' }),
    }),
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
Model-facing Skill guidance belongs in Agent Driver Instructions or deterministic imported instruction Markdown with an explicit `::skill{path="..."}` coverage block.
For harness-backed drivers, `skills()` contributes the skill directory to the Harness Workspace Session instead of adding model-facing instructions or tools.
With `shellExecution: 'write'`, model-backed Workspace Shell writes commit Workspace Session changes back into the Workspace.
With `source`, ViteHub still uses normal Workspace Source materialization, visibility, and Agent inspection metadata. `skills()` does not fetch source files at invocation time.
Global sources are materialized into an ephemeral harness profile for the session. Codex receives an isolated `CODEX_HOME` containing those Skills, an empty `config.toml`, and only the available authentication file from the configured Box or host profile.

## Requirements

Workspace-scoped `skills()` requires an explicit Workspace with read access to the configured skill file.
The path can point to a directory or directly to a `SKILL.md` file.
When `source` is configured, `path` is the canonical mount. ViteHub mounts the source at the configured skill directory even when the source helper has its own default mount.
File Sources are single-file and root-confined. Use a directory-capable `github()` or `custom()` Source, or a root-confined `glob()` Source, when a Skill source is a directory.
With `scope: 'global'`, `path` and `source` are required, `shellExecution` is unsupported, and the selected Harness Agent Driver must expose a global Skill directory.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Validates the skill file requirement and can read the mounted Skill through Workspace tools when tools are available. |
| Harness-backed | Mounts workspace-scoped Skills into the Harness Workspace Session and global-scoped Skills into the harness profile when the driver supports it. Codex supports both scopes. |
| Custom-run-backed | Validates the skill file requirement before `driver.run`. |

## Inspect and verify

Run the Agent with the configured Workspace.
A missing skill file should fail before model execution with a Workspace path requirement error.

Inspect Capability metadata for the normalized `path` and `skillPath` values.
Agent inspection metadata warns when a configured Skill lacks explicit instruction coverage.
The warning clears when Agent Driver Instructions or a deterministic imported instruction file covers the Skill.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | `"skills"` | Directory or `SKILL.md` path required in the Workspace. Required with global scope. |
| `scope` | `"global" \| "workspace"` | `"workspace"` | Mount the Skill into the Agent Workspace or the harness's isolated global profile. |
| `shellExecution` | `"read" \| "write"` | none | Optional Workspace Shell mode for model-backed Agents. Harness-backed Agents still receive the skill files, not Workspace Shell tools. |
| `source` | `WorkspaceSourceInput` | none | Workspace Source to mount at the skill directory. |
| `sourceKey` | `string` | derived from `path` | Workspace source key used when `source` is configured. |

Cover Skill usage guidance in Agent Driver Instructions with explicit Skill coverage blocks. Keep tool descriptions with Workspace Shell tools because they are structured tool contracts.

## Reference

- [Workspace primitive](/docs/server-primitives/workspace)
- [Agent instructions](/docs/agents/instructions)
- Source: `packages/agent/src/capabilities/skills.ts`
