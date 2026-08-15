---
title: Workspace context
description: Give an Agent scoped files and Sources with explicit read and write authority.
navigation.order: 32
navigation.group: Configure
icon: i-lucide-folder-search
---

Workspace context gives an Agent a named file tree and optional Sources. The Workspace decides what exists; Capabilities and the selected Driver decide how the Agent can access it.

Use a Workspace for project files, documentation, generated state, Source-backed paths, and controlled writeback. Do not use it as hidden prompt storage; model-facing policy belongs in [Instructions](/docs/agents/instructions).

## Add a read-only Workspace

Install the Workspace package and register its Vite plugin before the Agent plugin.

```bash [Terminal]
pnpm add @vite-hub/workspace
```

```ts [vite.config.ts]
import { hubAgent } from '@vite-hub/agent/vite'
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubWorkspace(),
    hubAgent(),
  ],
})
```

Declare a Source and grant a model-backed Driver read-only shell access:

```ts [server/agents/docs/agent.ts]
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'
import { glob } from '@vite-hub/workspace'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: [
      'Answer from the docs Source.',
      'Use Workspace inspection before answering. Say when evidence is missing.',
    ],
  },
  capabilities: [workspaceShell({ mode: 'read' })],
  workspace: {
    sourceRootDir: process.cwd(),
    sources: {
      docs: glob({ cwd: '.', include: ['docs/content/**/*.md'] }),
    },
  },
})
```

The Source makes files available under the Workspace. `workspaceShell({ mode: 'read' })` exposes read operations to the model. Without that Capability, declaring a Source alone does not grant model-facing file access.

## Reuse a Workspace

Use `defineWorkspace()` when several Agents share the same file tree or Source configuration.

```ts [server/workspaces/product-docs.ts]
import { defineWorkspace, glob } from '@vite-hub/workspace'

export default defineWorkspace({
  sourceRootDir: process.cwd(),
  sources: {
    docs: glob({ cwd: '.', include: ['docs/content/**/*.md'] }),
  },
})
```

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  capabilities: [workspaceShell({ mode: 'read' })],
  workspace: 'product-docs',
})
```

## Scope access by Actor

Use `access()` when trusted caller identity should narrow the files visible to one invocation. Place it before `workspaceShell()` so the shell receives the scoped Workspace.

```ts [server/agents/editor.ts]
import { defineAgent } from '@vite-hub/agent'
import { access, workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  capabilities: [
    access({
      workspace: {
        defaultScope: 'support',
        scopes: {
          support: { paths: ['support'] },
        },
      },
    }),
    workspaceShell({ mode: 'read' }),
  ],
  driver: { model: 'openai/gpt-5.1-mini' },
  workspace: 'product-docs',
})
```

Authenticate the request and pass an [Agent Actor](/docs/agents/actors) before deriving Actor-specific access. Workspace policy is an authorization boundary, so it should depend only on trusted identity and application-owned facts. Actor-scoped Workspace access from `access()` is read-only for model-backed and custom Drivers; provider Drivers receive a writable session limited to the selected paths. Without Actor-scoped Access, write authority depends on the Workspace mode, its rules, and the surfaces exposed to the Driver.

## Use Workspace context with a provider

Provider Drivers receive the rendered instruction document and selected Workspace files in a temporary local working directory. Successful write-mode invocations commit through Workspace rules.

```ts [server/agents/review/agent.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: { kind: 'codex', model: 'gpt-5.5' },
  workspace: { mode: 'write' },
})
```

## Keep context explicit

| Need | Use |
| --- | --- |
| Files or generated state | Workspace files and Sources |
| Model-facing rules | Colocated or Driver Instructions |
| Read or write tools | Capabilities such as `workspaceShell` |
| Caller-specific file scope | Access plus a trusted Agent Actor |
| Provider working directory | A write-mode Workspace |

Inspect the resolved Workspace, Sources, and access policy through the [CLI](/docs/development/cli) before relying on them in production.
