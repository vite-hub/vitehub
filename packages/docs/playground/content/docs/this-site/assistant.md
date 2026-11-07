---
title: The docs assistant
description: Why this demo has no Ask button. The docs assistant runs Codex, which needs a Node.js host, and this site runs on Cloudflare Workers.
navigation.order: 5
icon: i-lucide-message-square-text
---

`@vite-hub/docs` has a [docs assistant](https://vitehub.dev/docs/docs-site/assistant) that answers reader questions from the pages. It is off on this site.

The assistant runs Codex as a local process, and a Cloudflare Worker cannot start a process. A build for Workers with `docs.assistant` on stops with `DocsAssistantSetupError`.

| Host | Docs site | Console, CMS, Comments, MCP | Docs assistant |
| --- | --- | --- | --- |
| Cloudflare Workers | Yes | Yes | No |
| Node.js server | Yes | Yes | Yes |

To try the assistant, run the site on Node.js with `preset: 'node'`, and follow the [assistant guide](https://vitehub.dev/docs/docs-site/assistant).
