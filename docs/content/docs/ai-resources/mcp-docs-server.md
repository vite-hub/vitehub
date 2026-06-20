---
title: MCP docs server
description: Plan an MCP server that exposes ViteHub docs pages, metadata, and search to agents.
navigation.order: 62
icon: i-lucide-plug-zap
---

The MCP docs server is a planned AI resource for ViteHub documentation.
It should expose docs pages and metadata through Model Context Protocol resources without turning ViteHub itself into an MCP-only documentation product.

## Status

| Capability | Status | Notes |
| --- | --- | --- |
| ViteHub docs MCP server | Planned | No docs server implementation exists in this repo yet. |
| MCP Resource Source Loader | Available in Source Package | `@vite-hub/source` can consume read-only MCP resources from an external MCP Server. |
| MCP Capability for Agents | Available in Agent Package | `mcp()` connects Agents to executable MCP tools. |
| Docs-specific MCP resources | Planned | The docs server should expose read-only docs content and metadata. |

## Planned resources

| Resource | Purpose |
| --- | --- |
| `vitehub://docs/pages` | List docs pages with path, title, description, section, and updated metadata when available. |
| `vitehub://docs/page/<path>` | Read one Markdown page. |
| `vitehub://docs/search` | Search page titles, headings, and body text. |
| `vitehub://docs/packages` | Expose package reference metadata from docs and package manifests. |

## Boundary

The docs MCP server should expose read-only documentation resources.
Executable tools belong to the MCP Capability when an Agent connects to external MCP servers, not to docs page retrieval.

## Example client shape

This shape is illustrative until the docs MCP server exists.
It shows the boundary ViteHub should keep: docs resources are read-only Sources, while executable MCP tools stay separate.

```ts [server/workspaces/docs.ts]
import { defineWorkspace, source } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    vitehubDocs: source.mcpResources({
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
- Use [Markdown pages](/docs/ai-resources/markdown-pages) as the current page source.
- Use [Source Package](/docs/reference) for MCP Resource Source ownership.
