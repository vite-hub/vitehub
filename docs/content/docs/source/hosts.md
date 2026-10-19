---
title: Source hosts
description: Runtime requirements for each Source loader and the routes that need the Vite integration.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Providers

Source has no provider configuration. Each loader reaches its own origin from the server runtime.

| Loader | Origin | Runtime requirement |
| --- | --- | --- |
| `file()`, `markdown()` | Local file system below the Source root | Reads files with `node:fs` when a reader loads them. The runtime file system must contain the files. Inline `content` needs no file system. |
| `glob()` | Disk under `vite dev`; the server bundle after a build | None when its options are literals: the build bundles the files. Otherwise the runtime file system must contain them. |
| `files()` | Memory | None. It serves the files it is given. |
| `github()` | GitHub repository | Network access to GitHub. When `root` or `include` narrows the files, it first tries a sparse Git checkout, then falls back to the repository tarball. |
| `mcpResources()` | MCP server | An MCP client or an `http` or `sse` transport the runtime can reach. |
| `defineSource()` | Any origin | Whatever the custom loader uses. |

Collections and Content need generated routes. The `vitehub()` Vite plugin installs `hubSource()` for every preset, and the Nuxt module installs the same behavior. Direct Source reads and the process-local registry do not need Vite.
