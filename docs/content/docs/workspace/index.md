---
title: Workspace
navigation.title: Overview
description: Build persistent file-tree state with rules, Source Bindings, snapshots, diffs, and sessions.
navigation.order: 1
icon: i-lucide-folder-git-2
---

::agent-only{skill="workspace"}
Use Workspace for persistent file-tree state, Sources, access rules, snapshots, diffs, and sessions. A Workspace is the boundary for file authority and write-back.

Read [Get started](/docs/workspace/get-started), [Configure](/docs/workspace/configure), [Server API](/docs/workspace/server-api), or [Hosts](/docs/workspace/hosts).

Set the root, provider, mode, and write rules explicitly. Mount only the Sources an invocation needs. A mounted Source is context and does not imply write access.

Prove read, scoped write, diff, and restart or provider recovery. Inspect snapshots and generated Workspace state before relying on persistence.
::

::product-hero{tagline="A persistent file tree for server code and Agents, with the same calls on every Store provider." hosts="Node, Docker, Cloudflare, Vercel"}
  :::code-group
  ```ts [Session]
  import { resolveSandbox } from '@vite-hub/sandbox'
  import { useWorkspace } from '@vite-hub/workspace'

  export async function testDocs() {
    const sandbox = await resolveSandbox({ runtime: 'trusted-host' }, undefined)
    const host = await sandbox.open()
    const session = await useWorkspace('docs', { mode: 'write' }).startSession({ host })

    try {
      await session.exec('pnpm', ['test'])
      return await session.diff()
    }
    finally {
      await session.close()
      await host.close()
    }
  }
  ```

  ```ts [Definition]
  import { defineWorkspace, glob, github } from '@vite-hub/workspace'

  export default defineWorkspace({
    sources: {
      docs: glob({
        cwd: '.',
        include: ['README.md', 'docs/**/*.md'],
      }),
      handbook: github({
        repo: 'acme/handbook',
        ref: 'main',
        root: 'support',
        mount: 'handbook',
        materialize: 'lazy',
        sync: true,
      }),
    },
    rules: {
      '/**': { write: false },
      '/drafts/**': { write: true, mediaType: 'text/markdown' },
    },
  })
  ```

  ```ts [Agent]
  import { defineAgent } from 'vite-hub/agent'
  import { workspaceShell } from 'vite-hub/agent/capabilities'

  export default defineAgent({
    driver: { model: 'openai/gpt-5.1-mini' },
    workspace: { mode: 'write' },
    capabilities: [workspaceShell({ mode: 'write' })],
  })
  ```

  ```bash [CLI]
  pnpm vitehub workspace dev --url http://localhost:5173 docs exec pnpm test --filter api
  ```
  :::
::


::product-features
  :::product-feature-item{title="One file declares Sources and rules" icon="i-lucide-folder-tree" to="/docs/workspace/configure"}
  A Definition in `server/workspaces` sets Sources and path rules.
  :::

  :::product-feature-item{title="Sync a Source and snapshot the result" icon="i-lucide-code-2" to="/docs/workspace/server-api"}
  `workspace.sync()` returns per-Source counts and can snapshot the result.
  :::

  :::product-feature-item{title="Run a command and keep its diff" icon="i-lucide-terminal" to="/docs/workspace/server-api#use-sessions-and-shell"}
  A Sandbox Session diffs, commits, or rolls back on close.
  :::

  :::product-feature-item{title="Pick the Store once, keep the calls" icon="i-lucide-sliders-horizontal" to="/docs/workspace/configure#store-providers"}
  Local, Memory, Cloudflare Artifacts, Vercel Blob, GitHub, or a custom Store.
  :::

  :::product-feature-item{title="The same tree, as tools for an Agent" icon="i-lucide-bot" to="/docs/workspace/agent-capability"}
  `workspaceShell()` adds shell and file tools, bound by Workspace rules.
  :::

  :::product-feature-item{title="Changes stay inspectable" icon="i-lucide-history" to="/docs/workspace/server-api"}
  Read diffs and snapshots before an Agent writes them back.
  :::
::
