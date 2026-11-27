---
title: Docs site limits and errors
description: What @vite-hub/docs does not do yet, and the cause and fix of each error that it shows.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Limits

- **Nuxt only.** `@vite-hub/docs` is a Nuxt module. A Vite app without Nuxt cannot use it.
- **One design.** There are no themes. Change the design with `app.config.ts`, CSS variables, or your own components. See [Design](/docs/docs-site/configure#design).
- **Only folders are watched.** In development, the module watches `dir` and the folders in `sources`. Restart the app to see a change in another Source, such as `github()`: it gives its branch as it was when the app started or built. Sections are the folders under `base`, and a page belongs to one section.
- **Pages are read at build time.** The manifest, agent copies, and routes come from the files at build time, so a production site does not see files added later. In development, a body change shows on the next page load. A new page, title, or order restarts the app.
- **No page at `/docs` by default.** Without `content/docs/index.md`, `/docs` is not found and the Docs links open the first section.
- **Search runs in the browser.** Each production page loads the whole index once it is idle, or when the dialog opens with Save-Data on. Each `h2` and `h3` is one entry. Titles rank first, then headings, then text.
- **Comments need `vite-hub/nuxt`.** Threads live in a ViteHub Database. See [Comments](/docs/docs-site/configure#comments).
- **The docs assistant** runs Codex on Node.js and a model-backed Driver on Cloudflare Workers, both on the ChatGPT plan. See the [assistant limits](/docs/docs-site/assistant#limits) for plan use, shell access, and the rate limit.

## Errors

A build error of the docs module has a code, such as `DOCS_CONTENT_INVALID`, `DOCS_REDIRECTS_BROKEN`, or `DOCS_SEO_FAILED`. The error names the cause and the fix, and its `docs` link opens the page of its code.

### Assistant errors in the panel

The assistant panel shows its Agent and Connection errors, such as `AGENT_R1016` when the ChatGPT grant is missing. See [ChatGPT plan recovery](/docs/connections/chatgpt#recovery), [Connections limits and errors](/docs/connections/limits-and-errors), and [Errors and diagnostics](/docs/reference/errors-diagnostics).
