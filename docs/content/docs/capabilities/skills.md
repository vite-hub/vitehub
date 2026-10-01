---
title: Skills
description: Make a Workspace or external Source Skill available to an Agent.
navigation.title: Skills
navigation.order: 60
navigation.group: Workspace
icon: i-lucide-scroll-text
---

`skills()` makes a Skill file in the [Workspace](/docs/server-primitives/workspace), or from an external [Source](/docs/server-primitives/source), available to an Agent Invocation. It adds no model-facing tools unless `shellExecution` is set. Then model-backed Agents receive the Workspace Shell tools in that mode.

The Workspace and Source primitive pages cover application code. This page covers how an Agent receives a Skill.

Agent-owned Skills do not need this Capability. Use a folder Agent Definition whose entry file is `agent.ts`, `agent.js`, `index.ts`, or `index.js` (including the `c` and `m` variants), and place `skills/` beside that entry file. ViteHub discovers and materializes those files. Flat files such as `server/agents/support.ts` do not discover sibling Skills.

## Configure a Skill

The default path is `skills/SKILL.md`. Pass a custom `path` when the Workspace stores the Skill somewhere else.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { skills } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    skills(),
  ],
})
```

Mount a remote Skill Source when the Skill file is outside the project:

```ts [server/agents/review/browser.ts]
import { defineAgent } from 'vite-hub/agent'
import { skills } from 'vite-hub/agent/capabilities'
import { github } from 'vite-hub/workspace'

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

To add more than one Skill, give each additional `skills()` call a unique `id` that starts with `skills.`, for example `skills.browser`. Duplicate Capability ids fail at definition time. Agent inspection uses the `skills` id or `skills.` prefix to check Skill instruction coverage.

## How Skills are loaded

ViteHub validates the Workspace path requirement before the Agent Driver runs. The path can point to a directory or directly to a `SKILL.md` file.

With `source`, ViteHub adds the Source to the Agent Workspace at definition time and mounts it at the Skill directory. `path` is the canonical mount, even when the Source helper has its own default mount. ViteHub uses normal Workspace Source materialization, visibility, and Agent inspection metadata. `skills()` does not fetch Source files at invocation time.

For Provider Drivers, `skills()` adds the Skill directory to the Provider Workspace session. It adds no instructions or tools.

With `shellExecution`, model-backed and custom-run-backed Agents receive the Workspace Shell tools in that mode. With `shellExecution: 'write'`, Workspace Shell writes commit Workspace Session changes back into the Workspace.

### Instruction coverage

Put model-facing guidance for a Skill in Agent Driver Instructions or in deterministic imported instruction Markdown. Wrap that guidance in an explicit `::skill{path="..."}` coverage block. For model-backed and custom-run-backed Agents, Agent inspection warns when a configured Skill has no coverage block. Provider-backed Agents do not get this warning.

## Requirements

- An explicit Workspace with read access to the configured Skill path. `shellExecution: 'write'` requires write access.
- A directory-capable Source for a Skill directory. File Sources are single-file and root-confined. Use `github()`, `custom()`, or a root-confined `glob()` Source for a directory.

## Security and approval

`skills()` has no `policy` option. A Skill file is guidance for the Agent. Treat a Skill Source as trusted input, and point it at a repository and root that you control or review.

`shellExecution` tools are not limited to the Skill directory. `shellExecution: 'read'` lets the Agent inspect the whole visible Workspace. `shellExecution: 'write'` also lets it change any path that Workspace rules allow, without approval.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Validates the Skill path requirement. Reads the Skill through Workspace tools when tools are available. Receives Workspace Shell tools with `shellExecution`. |
| Provider-backed | Mounts the Skill into the Provider Workspace session. Receives no Workspace Shell tools, even with `shellExecution`. |
| Custom-run-backed | Validates the Skill path requirement before `driver.run`. Receives Workspace Shell tools in `driver.run({ tools })` with `shellExecution`. |

## Verify the Skill

1. Run `vitehub agent info --agent <name> --json` and confirm that the Capability metadata shows the normalized `path` and `skillPath`, plus `sourceKey` when `source` is set.
2. Check `warnings` for an `instruction-coverage:skill:<path>` entry. Add a `::skill{path="<path>"}` block to clear it.
3. Remove the Skill file and run the Agent. Confirm that it fails before model execution with a Workspace path requirement error.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | `"skills"` | Directory or `SKILL.md` path required in the Workspace. A directory resolves to `<path>/SKILL.md`. |
| `id` | `string` | `"skills"` | Capability id. Use a unique id such as `skills.browser` for each additional Skill. |
| `shellExecution` | `"read" \| "write"` | none | Workspace Shell mode for model-backed and custom-run-backed Agents. |
| `source` | `WorkspaceSourceInput` | none | Workspace Source to mount at the Skill directory. |
| `sourceKey` | `string` | derived from `path` | Workspace Source key used with `source`, for example `skill.agent-browser` for `skills/agent-browser`. |

## Related pages

- [Workspace primitive](/docs/server-primitives/workspace)
- [Source primitive](/docs/server-primitives/source)
- [Agent instructions](/docs/agents/instructions)
- [workspaceShell()](/docs/capabilities/workspace-shell)
- [Official Capabilities](/docs/capabilities/official-capabilities)
