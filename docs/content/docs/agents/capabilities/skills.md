---
title: Skills
description: Give an Agent a Skill file from the Workspace or from an external Source, and check that the Agent loads it.
navigation.title: Skills
navigation.order: 160
navigation.group: Capabilities
icon: i-lucide-scroll-text
---

A Skill is a `SKILL.md` file that tells an Agent how to do a task. `skills()` gives an Agent a Skill from the [Workspace](/docs/workspace) (the Agent's files) or an external [Source](/docs/source). It adds no tools unless you set `shellExecution`, which gives model-backed Agents the Workspace Shell tools in that mode. App code uses the [Workspace server API](/docs/workspace/server-api) and [Source server API](/docs/source/server-api).

A Skill owned by one Agent does not need this Capability. Make the Agent a folder with an `agent.ts`, `agent.js`, `index.ts`, or `index.js` entry file (`c` and `m` variants work), and put `skills/` next to it. ViteHub finds and materializes those files. A flat file such as `server/agents/support.ts` does not.

## Configure a Skill

The default path is `skills/SKILL.md`. Pass `path` for another location.

```ts [server/agents/support.ts] fragment
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

Mount a remote Source when the Skill is outside the project:

```ts [server/agents/review/browser.ts] fragment
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

For more Skills, give each extra `skills()` call a unique `id` starting with `skills.`, such as `skills.browser`. Duplicate ids fail at definition time. Inspection uses the `skills` id or `skills.` prefix to check instruction coverage.

## How Skills are loaded

- Before the Driver runs, ViteHub checks that the path, a folder or a `SKILL.md` file, exists in the Workspace.
- With `source`, ViteHub adds the Source to the Workspace at definition time, mounted at `path`, even when the Source helper has its own default mount. It loads and inspects like any Workspace Source. `skills()` fetches nothing at run time.
- For Provider Drivers, `skills()` adds the Skill folder to the Provider Workspace session, with no instructions or tools.
- `shellExecution` gives model-backed and custom-run-backed Agents the Workspace Shell tools. With `'write'`, Shell changes are saved back to the Workspace.

### Instruction coverage

Tell the model when to use the Skill in the Agent Driver Instructions or deterministic imported instruction Markdown, inside a `::skill{path="..."}` block. For model-backed and custom-run-backed Agents, inspection warns when a Skill has no block. Provider-backed Agents get no warning.

## Requirements

- An explicit Workspace with read access to the configured Skill path. `shellExecution: 'write'` requires write access.
- For a Skill folder, a Source that holds folders: `github()`, `custom()`, or a root-confined `glob()`. File Sources hold one root-confined file.

## Security and approval

`skills()` has no `policy` option. The Agent follows a Skill, so point a Skill Source only at a repository and root you control or review.

> [!WARNING]
> `shellExecution` tools are not limited to the Skill folder. `'read'` can read the whole visible Workspace. `'write'` can also change any path Workspace rules allow, without approval.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Checks the Skill path. Reads the Skill through Workspace tools when available. Gets Shell tools with `shellExecution`. |
| Provider-backed | Mounts the Skill into the Provider Workspace session. No Shell tools, even with `shellExecution`. |
| Custom-run-backed | Checks the Skill path before `driver.run`. Gets Shell tools in `driver.run({ tools })` with `shellExecution`. |

## Verify the Skill

1. Run `vitehub agent info --agent <name> --json` and check that the metadata shows the normalized `path` and `skillPath`, plus `sourceKey` with `source`.
2. Clear any `instruction-coverage:skill:<path>` entry in `warnings` with a `::skill{path="<path>"}` block.
3. Remove the Skill file and check that the run fails before the model runs, with a Workspace path requirement error.

To try this, enable the Workspace with `vitehub({ host: 'node', agent: true, workspace: true })` (see [Workspace context](/docs/agents/workspace-context#add-a-read-only-workspace)). With the default Local Store, create `.vitehub/workspaces/support/skills/review/SKILL.md` and use this Agent:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { skills } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: [
      '::skill{path="skills/review"}',
      'Use the review Skill.',
      '::',
    ],
  },
  workspace: { name: 'support' },
  capabilities: [
    skills({ path: 'skills/review' }),
  ],
})
```

Start the Vite development server and inspect the Capability:

```bash [Terminal]
pnpm vitehub agent info --agent support --json \
  | jq '.capabilities[] | select(.id == "skills") | .metadata'
```

The output has the normalized paths:

```json
{
  "path": "skills/review",
  "skillPath": "skills/review/SKILL.md"
}
```

Delete `.vitehub/workspaces/support/skills/review/SKILL.md` and run `pnpm vitehub agent dev --agent support --prompt "check"`. It must stop before the model runs with `skills() requires workspace path skills/review/SKILL.md`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | `"skills"` | Required folder or `SKILL.md` path. A folder means `<path>/SKILL.md`. |
| `id` | `string` | `"skills"` | Capability id. Use a unique one, such as `skills.browser`, for each extra Skill. |
| `shellExecution` | `"read" \| "write"` | none | Shell mode for model-backed and custom-run-backed Agents. |
| `source` | `WorkspaceSourceInput` | none | Source to mount at the Skill folder. |
| `sourceKey` | `string` | derived from `path` | Source key, such as `skill.agent-browser` for `skills/agent-browser`. |

## Related pages

- [Workspace primitive](/docs/workspace)
- [Source primitive](/docs/source)
- [Agent instructions](/docs/agents/instructions)
- [workspaceShell()](/docs/workspace/agent-capability)
- [Official Capabilities](/docs/agents/capabilities/official)
