---
title: Cloudflare Workspace Compatibility
description: How @vitehub/workspace maps to Cloudflare storage and execution primitives.
navigation.title: Cloudflare
navigation.group: Providers
navigation.order: 10
icon: i-simple-icons-cloudflare
frameworks: [vite, nitro]
---

`@vitehub/workspace` supports Cloudflare Artifacts as the hosted v1 workspace store. Cloudflare support keeps storage and execution roles separate:

| Cloudflare primitive | Intended role |
| --- | --- |
| Artifacts | Canonical versioned file-tree store. |
| Shell / virtual workspace | Workspace runtime for read, write, search, diff, and glob without a full machine. |
| R2 | Large-object spillover for workspace stores. |
| Sandbox | Isolated execution when commands, compilers, or full OS access are needed. |

Cloudflare Artifacts stores versioned file trees behind a Git-compatible interface. ViteHub binds Artifacts through Wrangler and uses `snapshot()` as the commit boundary for hosted workspace writes.

```ts
export default defineWorkspace({
  store: {
    provider: 'cloudflare-artifacts',
    binding: 'WORKSPACE_ARTIFACTS',
    namespace: 'vitehub',
    repoPrefix: 'vitehub-workspace-',
    branch: 'main',
  },
})
```

The public API remains source-oriented:

```ts
source.github({
  repo: 'acme/app',
  ref: 'main',
  root: 'docs',
})
```

Hosted Cloudflare providers should keep Artifacts, R2, Shell, and Sandbox as implementation details behind the workspace store/runtime adapters.
