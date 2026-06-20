---
title: llms.txt
description: Expose a compact ViteHub docs index for AI tools and coding agents.
navigation.title: llms.txt
navigation.order: 60
icon: i-lucide-file-text
---

`llms.txt` is the AI-facing index for ViteHub documentation.
It gives agents a compact way to discover canonical docs pages before reading full Markdown pages or using a future MCP docs server.

## Status

| Affordance | Status | Source of truth |
| --- | --- | --- |
| `llms.txt` route | Configured in the docs app | `docs/nuxt.config.ts` sets the Nuxt Content `llms` domain. |
| Full-page Markdown | Available as source files; raw public per-page Markdown routes are planned | `docs/content/docs/**/*.md`. |
| MCP docs server | Planned | No ViteHub docs MCP server implementation exists in this repo yet. |
| Agent instructions and skills | Planned docs affordance | Repo instructions exist in `AGENTS.md` and `.agents/**`, but public docs packaging is not implemented. |

## Configure the domain

The docs app configures the public domain used for AI resource URLs.
Keep the domain stable because agents may cache links from `llms.txt`.

```ts [docs/nuxt.config.ts]
export default defineNuxtConfig({
  llms: {
    domain: 'https://vitehub.dev',
  },
})
```

## What agents should do

Agents should read `llms.txt` first when they need the public docs map.
Then they should open the relevant Markdown page, package reference, or local source file.

```txt [Agent flow]
1. Read /llms.txt.
2. Pick the relevant ViteHub docs URL.
3. Read the full page.
4. Inspect package source only when the docs do not answer the implementation detail.
```

## Next steps

- Use [Markdown pages](/docs/ai-resources/markdown-pages) for page-level source access.
- Use [MCP docs server](/docs/ai-resources/mcp-docs-server) for the planned tool interface.
- Use [Agent instructions and skills](/docs/ai-resources/agent-instructions-skills) for repo-local guidance.
