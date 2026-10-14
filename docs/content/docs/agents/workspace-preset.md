---
title: Workspace preset
description: Read mounted Sources and cite files at their resolved GitHub revision.
navigation.order: 93
navigation.group: Presets
icon: i-lucide-folder-search
---

The Workspace preset supplies a read-only Codex Agent and instructions for citing mounted Sources. It uses Source provenance to build GitHub links to the exact revision read by the Agent.

## Add the Agent

Enable `agent: true` and `workspace: true` in your [ViteHub configuration](/docs/agents/workspace-context#add-a-read-only-workspace). Import the preset's default export and declare the Sources to read:

```ts [server/agents/docs/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import workspace from 'vite-hub/agent/presets/workspace'
import { github } from 'vite-hub/source/github'

export default defineAgent({
  preset: 'workspace',
  presets: { workspace },
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

Add project guidance in `server/agents/docs/instructions.md`:

```md [server/agents/docs/instructions.md]
Answer questions from the mounted docs Source.
Read the relevant files before answering and cite the lines you used.
Say when the Source does not contain the answer.
```

Run this Agent through your application's [invocation path](/docs/agents/invocations) or attach a [Channel](/docs/agents/channels). The preset supplies no Channel or background worker.

## What the preset supplies

| Setting | Behavior |
| --- | --- |
| `driver.kind` | Codex. Configure its model and provider settings in `driver`. |
| `workspace.mode` | Read-only access to the mounted file tree. |
| Instructions | Source provenance, citation rules, and a slot for your project guidance. |

The preset adds no tools or workflow options. Codex reads the configured Workspace through its provider file access. Your application supplies the Sources, provider authentication, invocation path, and storage configuration.

## Citation behavior

The instructions ask the Agent to map each cited mounted path to its Source metadata and use a GitHub HTTPS link with the resolved revision ID. They include the Source root, encode each path segment, and add a line anchor when known.

For the example above, a citation has this form:

```text
https://github.com/vite-hub/vitehub/blob/<resolved-commit>/docs/content/docs/agents/presets.md#L10
```

The Agent is instructed to omit a link when a file cannot be mapped to exact provenance. Local Sources without GitHub provenance do not gain a guessed repository URL. These are model instructions; the preset does not validate citations in the returned text.

Use [Workspace context](/docs/agents/workspace-context) to configure access and shared file trees, and [Source configuration](/docs/source/configure) for loader settings and revision behavior.
