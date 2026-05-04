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

Cloudflare Artifacts stores versioned file trees behind a Git-compatible interface. On Cloudflare Nitro builds, registering the module is enough for ViteHub to use the default Artifacts binding and emit the generated Wrangler config.

```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/workspace/nitro'],
})
```

The default Cloudflare store uses binding `WORKSPACE_ARTIFACTS`, namespace `vitehub`, branch `main`, and repository names generated from `vitehub-workspace-` plus the workspace name. Use environment variables or explicit store options only when those defaults need to change.

The public API remains source-oriented:

```ts
import * as source from '@vitehub/workspace/source'

source.github({
  repo: 'acme/app',
  ref: 'main',
  root: 'docs',
})
```

Hosted Cloudflare providers should keep Artifacts, R2, Shell, and Sandbox as implementation details behind the workspace store/runtime adapters.
