---
title: Workspace preset
description: Read mounted Sources and cite files at their resolved GitHub revision.
navigation.order: 92
navigation.group: Presets
icon: i-lucide-folder-search
navigation.kind: Guides
---

The Workspace preset gives you a read-only Codex Agent that answers from mounted Sources (file trees such as a GitHub repository). It cites each file with a GitHub link to the exact revision it read.

## Add the Agent

Set `agent: true` and `workspace: true` in your [ViteHub configuration](/docs/agents/workspace-context#add-a-read-only-workspace). Then import the preset and list the Sources to read:

```ts [server/agents/docs/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import workspace from 'vite-hub/presets/workspace'
import { github } from 'vite-hub/source'

export default defineAgent({
  extends: workspace,
  driver: { model: 'your-codex-model' },
  workspace: {
    sources: {
      docs: github({
        repo: 'vite-hub/vitehub',
        ref: 'main',
        root: 'docs/content',
      }),
    },
  },
})
```

Add your project guidance:

```md [server/agents/docs/instructions.md]
Answer questions from the mounted docs Source.
Read the relevant files before answering and cite the lines you used.
Say when the Source does not contain the answer.
```

Run the Agent through your app's [invocation path](/docs/agents/invocations) or a [Channel](/docs/agents/channels). The preset adds no Channel or background worker.

## What the preset supplies

| Setting | Behavior |
| --- | --- |
| `driver.kind` | Codex. Set its model and provider settings in `driver`. |
| `workspace.mode` | Read-only access to the mounted files. |
| Instructions | Source provenance, citation rules, and a slot for your project guidance. |

The preset adds no tools or workflow options. Codex reads the Workspace through its own file access. Your app gives the Sources, provider authentication, invocation path, and storage.

## Citation behavior

The instructions tell the Agent to map each cited path to its Source and link to GitHub at the resolved revision. The link includes the Source root, encodes each path segment, and adds a line anchor when known. For the example above:

```text
https://github.com/vite-hub/vitehub/blob/<resolved-commit>/docs/content/docs/agents/presets.md#L10
```

The Agent omits a link when it cannot map a file to an exact revision. Local Sources without GitHub data get no guessed URL.

> [!NOTE]
> These are model instructions. The preset does not check the citations in the answer.

Read [Workspace context](/docs/agents/workspace-context) to set access and shared file trees, and [Source configuration](/docs/source/configure) for loaders and revisions.
