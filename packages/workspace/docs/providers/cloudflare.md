---
title: Cloudflare Workspace Compatibility
description: How @vitehub/workspace maps to Cloudflare storage and execution primitives.
navigation.title: Cloudflare
navigation.group: Providers
navigation.order: 10
icon: i-simple-icons-cloudflare
frameworks: [vite, nitro]
---

`@vitehub/workspace` is local-first in v1. Cloudflare support is designed around separate storage and execution roles:

| Cloudflare primitive | Intended role |
| --- | --- |
| Artifacts | Future canonical versioned file-tree store. |
| Shell / virtual workspace | Workspace runtime for read, write, search, diff, and glob without a full machine. |
| R2 | Large-object spillover for workspace stores. |
| Sandbox | Isolated execution when commands, compilers, or full OS access are needed. |

Cloudflare Artifacts stores versioned file trees behind a Git-compatible interface, which makes it the best fit for future hosted workspace state. Cloudflare Sandbox and Shell-style filesystem APIs are runtime capabilities, not the identity of the workspace.

The public API remains source-oriented:

```ts
source.github({
  repo: 'acme/app',
  ref: 'main',
  root: 'docs',
})
```

Hosted Cloudflare providers should keep Artifacts, R2, Shell, and Sandbox as implementation details behind the workspace store/runtime adapters.
