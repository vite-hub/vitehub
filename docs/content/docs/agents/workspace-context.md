---
title: Workspace context
description: Give Agents scoped file-tree state and Sources without granting unrestricted filesystem access.
navigation.order: 28
icon: i-lucide-folder-search
---

Workspace context gives an Agent a named Workspace File Tree and optional Sources. The Workspace owns file visibility, Source materialization, and Workspace Scope, while Capabilities decide which runtime surfaces the active Agent Driver can use.

Use Workspace context when the Agent needs project files, documentation, generated state, Source-backed paths, or controlled file mutation. Do not use it as a hidden prompt bag.

## Add Agent Instructions

Put shared Agent instructions beside the colocated Agent config:

```md [server/agents/docs/instructions.md]
Answer from the docs workspace. Say when the answer is not present.
```

ViteHub materializes `server/agents/<name>/instructions.md` into the Agent Workspace as `AGENTS.md`. Model-backed Agent Drivers use it as the default instructions when `driver.instructions` or legacy `instructions` are not configured. Harness-backed Agent Drivers receive the rendered document in their Workspace session as `AGENTS.md`, plus `CLAUDE.md` for Claude Code-compatible harnesses.

## Declare Sources

Declare a colocated Workspace when the Agent primarily owns the file-tree context. Put model-facing guidance about how to use a Source in Agent Driver Instructions or deterministic imported instruction Markdown.

Install the Workspace Package and register its Vite integration before the Agent integration when the Agent declares Workspace Sources.

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

```ts [server/agents/docs/config.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'
import { glob } from '@vite-hub/workspace'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: [
      'Answer from the docs Source before using outside knowledge.',
      'Say when the docs do not cover the answer.',
    ],
  },
  workspace: {
    sources: {
      docs: glob({
        cwd: '.',
        include: ['README.md', 'docs/**/*.md'],
      }),
    },
  },
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
})
```

The Workspace supplies files. The Workspace Shell Capability exposes read or write tools to compatible Agent Drivers.

## Reuse a Workspace

Use a string when another Agent should read an existing Workspace. Use `{ name, mode: 'write' }` when it should write artifacts into that same Workspace File Tree.

```ts [server/agents/summary/config.ts]
export default defineAgent({
  workspace: { name: 'review', mode: 'write' },
  capabilities: [
    workspaceShell({ mode: 'write' }),
  ],
})
```

## Cover Source usage

Current ViteHub can render visible Source Instructions into a `## Workspace Sources` block for model-backed drivers. Put `{{ workspace.sources }}` where that block belongs when you are using existing Source Instructions.

Only visible Sources render. If Access selects a Workspace Scope, ViteHub omits hidden Source Instructions along with hidden files.

Direction: ViteHub should warn when a visible Source is configured but lacks explicit instruction coverage in Agent Driver Instructions or a deterministic imported instruction file. Do not rely on a file merely existing in the Workspace to clear that warning.

Explicit `driver.instructions` still wins when the Agent needs custom prompt composition. Ordinary Workspace files named `AGENTS.md` are just files; only colocated `instructions.md` is the default Agent instructions convention.

Use `workspace.bindings` when an instruction document needs an explicit Workspace-owned value or Markdown fragment. `{{ workspace.foo }}` renders scalar text, and `@workspace.foo` inserts the declared Markdown binding before Instruction Composition continues. `{{ workspace.sources }}` remains reserved for current Source Instructions and does not come from `workspace.bindings`.

## Start with read access

Use read mode when the Agent only needs to inspect files. Use write mode only when the product expects the Agent to mutate Workspace files and Workspace Rules allow the target paths.

```ts [server/agents/docs/config.ts]
import { workspaceShell } from '@vite-hub/agent/capabilities'

export const workspaceAccess = [
  workspaceShell({ mode: 'read' }),
]
```

Workspace access is not process access by default. Use execution Capabilities deliberately when the Agent needs commands, shell behavior, or sandboxed mutation.

## Harness Workspace Sessions

Harness-backed Agent Drivers receive Workspace state through a Harness Workspace Session instead of model-facing Workspace Tools by default.

```ts [server/agents/review/config.ts]
import { createCodex } from '@ai-sdk/harness-codex'
import { defineAgent } from '@vite-hub/agent'
import { skills } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: {
    harness: createCodex({
      model: 'gpt-5.5',
    }),
  },
  workspace: {
    mode: 'write',
  },
  capabilities: [
    skills({ path: '.agents/skills/review' }),
  ],
})
```

Read mode materializes the selected Workspace into the harness sandbox and discards sandbox changes. Write mode syncs additions, updates, and deletions back through Workspace rules. Capabilities can also contribute harness-only Workspace paths, such as skill directories, without broadening the product-data Workspace Scope. Keep Skills behind the `skills()` Capability; ViteHub does not add root `skills`, `tools`, or `sandbox` Agent Definition fields for harness-backed Agents. Put harness guidance in colocated `instructions.md`; model-facing Source Instructions are not forwarded to harness-backed Agent Drivers yet.

## Scope by Agent Invoker

Use the Access Capability when the Agent Invoker should narrow the visible Workspace Scope for one Agent Invocation.

```ts [server/agents/support/config.ts]
import { access, workspaceShell } from '@vite-hub/agent/capabilities'

export const supportCapabilities = [
  access({
    workspace: {
      resolve({ invoker }) {
        if (invoker.meta?.scope === 'all') {
          return { all: true, scope: 'support' }
        }

        const customer = String(invoker.meta?.customer ?? '')
        return {
          grants: [
            { path: 'AGENTS.md' },
            { path: `customers/${customer}` },
          ],
          instructions: customer
            ? `Answer for the ${customer} customer workspace.`
            : 'Answer from the public support workspace.',
          scope: customer || 'public',
        }
      },
    },
  }),
  workspaceShell({ mode: 'read' }),
]
```

Workspace Scope Instructions are explicit prompt text for the selected scope. ViteHub does not generate prompt text from scope names, grants, roles, Source metadata, or invoker metadata.

## Resolve Sources per invocation

Source Resolution can narrow a Source from trusted invocation context, such as a Selected Workspace Scope or an Agent Invocation Context Value. Source Resolution is source shaping, not authorization.

```ts [server/agents/support/config.ts]
import { github } from '@vite-hub/workspace'

export const supportSources = {
  ingestion: github(({ invocation }) => {
    const customer = invocation.context.get<{ customer?: string }>('support.customer')?.customer

    return {
      repo: 'acme/ingestion',
      root: customer ? `dbt/${customer}` : 'dbt',
      mount: customer ? `ingestion/${customer}` : 'ingestion',
    }
  }),
}
```

Access remains the boundary that decides which Workspace paths are visible. Source Resolution changes where visible Source-backed paths come from.

## Next steps

- Read [Invokers](/docs/agents/invokers) for trusted identity.
- Read [Instructions](/docs/agents/instructions) for explicit instruction coverage.
- Read [Capabilities](/docs/capabilities) for `access()` and `workspaceShell()`.
