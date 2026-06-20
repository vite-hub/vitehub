---
title: Source
description: Retrieve read-only files, records, and external resources through typed source loaders.
navigation.order: 8
icon: i-lucide-folder-input
---

Source owns typed retrieval from read-only origins. Use it when server code needs addressable content from files, globs, markdown, GitHub, MCP resources, or custom loaders without first modeling a persistent Workspace file tree.

Source does not own Workspace placement, Source Sync, Workspace rules, snapshots, or model-facing Source Instructions. Workspace can consume Sources and decide where retrieved items appear in a Workspace File Tree.

## Define Sources

Use `@vite-hub/source` when you want a direct retrieval registry.

```ts [server/sources.ts]
import { defineSources, file, github, registerSources } from '@vite-hub/source'

export const sources = defineSources({
  readme: file('README.md'),
  docs: github({
    repo: 'acme/docs',
    ref: 'main',
    root: 'docs',
    include: ['**/*.md'],
  }),
})

registerSources(sources)
```

Named Source Loader imports are the preferred authoring shape. The `source` namespace remains available when grouped imports read better.

Source has no discovery by itself. Import the module that registers Sources before calling `useSource()` in a process.

## Use it at runtime

Read a Source by name with `useSource()`.

```ts [server/api/readme.get.ts]
import '../sources'
import { useSource } from '@vite-hub/source'

export default defineEventHandler(async () => {
  const readme = useSource('readme')

  return {
    text: await readme.read('README.md'),
  }
})
```

A Source Reader can list keys, read text or binary content, fetch metadata, check existence, and list direct children.

```ts [server/api/docs.get.ts]
import '../sources'
import { useSource } from '@vite-hub/source'

export default defineEventHandler(async () => {
  const docs = useSource('docs')

  return {
    files: await docs.keys(),
    root: await docs.list(''),
  }
})
```

## Use Sources with Workspace

Use Workspace Source Bindings when retrieved content should appear inside a persistent Workspace file tree.

```ts [server/workspaces/docs.ts]
import { defineWorkspace, source } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    readme: source.file('README.md'),
    docs: source.github({
      repo: 'acme/docs',
      root: 'docs',
      mount: 'docs',
      materialize: 'lazy',
    }),
  },
})
```

The Source Package owns retrieval. The Workspace Package owns Mount placement, Source-Backed Paths, Source Sync Policy, Source Instructions, and Workspace Store reconciliation.

## Provider output

`@vite-hub/source` is a retrieval primitive, not a Vite Integration. It does not generate host output by itself.

Workspace and other consuming packages can wrap Source Definitions in discovered Definitions, runtime registries, generated metadata, or Provider Output when they need placement, persistence, or deployment wiring.

## Connect it to Agents

Agents usually see Sources through Workspace. Source Instructions are Workspace-owned metadata that guide model-backed Agent Drivers, and `workspaceShell()` exposes visible Workspace files through controlled tools.

Use [MCP](/docs/capabilities/mcp) for executable MCP tools. Use Source only for read-only MCP Resource Source Loader content.

## Production boundaries

Treat Sources as read-only retrieval boundaries. Secrets for private origins should come from Server Env or trusted callbacks, not from model-authored input.

Use Workspace when content needs durable sync, path-scoped rules, diffs, snapshots, or scoped agent visibility. Use Source directly when server code only needs to retrieve and inspect items.

## Next steps

- Learn the shared model in [Workspace and Sources](/docs/concepts/workspace-and-sources).
- Persist retrieved content through [Workspace](/docs/server-primitives/workspace).
- Expose visible Workspace content to agents through [Official capabilities](/docs/capabilities/official-capabilities).
