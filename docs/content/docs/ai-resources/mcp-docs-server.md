---
title: MCP docs server
description: Track the planned MCP docs resource boundary for ViteHub documentation.
navigation.order: 62
icon: i-lucide-plug-zap
---

The MCP docs server is a planned AI resource for ViteHub documentation.
It should expose docs pages and metadata through Model Context Protocol resources.

Use `llms.txt` and raw Markdown routes today.
No ViteHub docs MCP server implementation exists in this repository yet.

## Status

| Capability | Status | Notes |
| --- | --- | --- |
| ViteHub docs MCP server | Planned | No docs server implementation exists in this repo yet. |
| MCP Resource Source Loader | Available in Source Package | `@vite-hub/source` can consume read-only MCP resources from an external MCP Server. |
| MCP Capability for Agents | Available in Agent Package | `mcp()` connects Agents to executable MCP tools. |
| Docs-specific MCP resources | Planned | Use raw Markdown routes until this exists. |

## Planned boundary

The docs MCP server should expose read-only documentation resources such as page lists, page Markdown, search results, and package metadata.
Executable tools belong to the MCP Capability when an Agent connects to external MCP servers, not to docs page retrieval.

## Example client shape

This shape is illustrative until the docs MCP server exists.
It shows the boundary ViteHub should keep: docs resources are read-only Sources, while executable MCP tools stay separate.

```ts [server/workspaces/docs.ts]
import { defineWorkspace, mcpResources } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    vitehubDocs: mcpResources({
      server: {
        transport: {
          type: 'http',
          url: 'https://vitehub.dev/mcp',
        },
      },
    }),
  },
})
```

## Next steps

- Use [llms.txt](/docs/ai-resources) as the current public index.
- Use [Markdown pages](/docs/ai-resources/markdown-pages) for current page content.
- Use [Source Package](/docs/reference) for MCP Resource Source ownership.
