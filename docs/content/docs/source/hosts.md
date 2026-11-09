---
title: Source hosts
description: What each Source loader needs at runtime, and which routes need the Vite plugin.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Providers

Source has no provider config. Each loader, such as `glob()` or `github()`, reads its origin from the server.

| Loader | Origin | Runtime requirement |
| --- | --- | --- |
| `file()`, `markdown()` | Local file system below the Source root | Reads with `node:fs`, so the files must exist at runtime. Inline `content` needs no file system. |
| `glob()` | Disk under `vite dev`; the server bundle after a build | None with literal options, because the build bundles the files. Else the files must exist at runtime. |
| `files()` | Memory | None. It serves the files you give it. |
| `github()` | GitHub repository | Network access to GitHub. When `root` or `include` narrows the files, it tries a sparse Git checkout first, then the repository tarball. |
| `mcpResources()` | MCP server | An MCP client, or an `http` or `sse` transport the server can reach. |
| `defineSource()` | Any origin | What your loader uses. |

Collections and Content need generated routes. `vitehub()` and the Nuxt module add `hubSource()` for every host. Direct reads and the in-process registry do not need Vite.
