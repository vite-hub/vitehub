---
title: Docs site limits and errors
description: What @vite-hub/docs does not do yet, and the cause and fix of each error that it shows.
navigation.title: Limits and errors
navigation.order: 6
icon: i-lucide-circle-alert
---

## Limits

- **Nuxt only.** `@vite-hub/docs` is a Nuxt module. A Vite app without Nuxt cannot use it.
- **One theme.** `vercel` is the only theme. Change it with `app.config.ts` and CSS variables, or replace components. See [Theme](/docs/docs-site/configure#theme).
- **One content folder.** The module reads one folder, `dir`. Sections are the folders under `base`. A page cannot be in two sections.
- **Pages are read at build time.** The manifest, the agent copies, and the routes come from the files at build time. A production site does not see a file that you add after the build. In development, a body change shows on the next page load, and a new page, title, or order restarts the app.
- **No page at `/docs` by default.** Add `content/docs/index.md`, or `/docs` is not found. The Docs links then open the first section.
- **Search is in the browser.** The dialog loads the whole index the first time it opens. Each `h2` and `h3` is one entry. Page titles rank first, then headings, then text.
- **Comments need `vite-hub/nuxt`.** Threads live in a ViteHub Database. A site without `vite-hub/nuxt` has no Comments. See [Comments](/docs/docs-site/configure#comments).
- **The docs assistant** runs Codex on Node.js and a model-backed Driver on Cloudflare Workers, both on the ChatGPT plan. See the [assistant limits](/docs/docs-site/assistant#limits) for plan use, shell access, and the rate limit.

## Errors

### DocsContentError

The frontmatter of a page, or a `.navigation.yml` file, does not match the schema. The build stops on the first invalid file. The message names the file and each wrong field:

```txt [output/docs-content-error.txt]
Invalid docs frontmatter in content/docs/guide/install.md: layout: Invalid type: Expected ("article" | "tutorial" | "landing") but received "wide"
```

**Why:** a required field is missing, such as `title`, or a field has a wrong value or type.

**Fix:** correct the field that the message names. The [frontmatter reference](/docs/docs-site/server-api#frontmatter) lists every field and its values. In development, the terminal shows the error and the site keeps the last valid pages until you fix the file.

### DocsRedirectError

A redirect route rule breaks a link. A production build stops on it while the link checker is on. The message lists each rule with its fix:

```txt [output/docs-redirect-error.txt]
Docs redirects break links:
- The redirect from /docs/old goes to /docs/nowhere, which is not a docs page. Point it to a page, or remove the route rule.
- The redirect from /docs/guide/install hides the page docs/guide/install.md. Remove the route rule, or move the page.
```

**Why:** the link checker passes a link to a redirect rule, so the redirect must lead to a page. A redirect into a section, the docs base, or `/raw/` goes to a path that no docs page answers. Or a redirect starts at a docs page, so nobody can open that page. Or redirects lead back to where they started. A redirect to another redirect counts where the chain ends.

**Fix:** point the rule's `redirect` to a page, or remove the rule. The module checks exact rules only: a wildcard rule such as `/docs/old/**`, and a target outside the docs, keep the link checker's own checks.

### DocsAssistantSetupError

The build shows it as `[@vite-hub/docs]` followed by the cause and the fix.

**Why:** `assistant` is on, and the app has no `vite-hub/nuxt` module with `agent: true`.

**Fix:** add `['vite-hub/nuxt', { agent: true, connections: true, database: true }]` to `modules`. Or set `assistant: false`. See [Turn it on](/docs/docs-site/assistant#turn-it-on).

### DocsCommentsSetupError

The build shows it as `[@vite-hub/docs]` followed by the cause and the fix.

**Why:** Comments is on, and it cannot run. One of these:

- The app has `vite-hub/nuxt` but not `@vite-hub/comments`.
- `vite-hub/nuxt` sets `database: false`. Comments keeps threads in the Database.
- `docs.comments` is `true` or an object, and the app has no `vite-hub/nuxt`.

**Fix:** run `pnpm add @vite-hub/comments`, remove `database: false`, or add `vite-hub/nuxt` to `modules`. Or set `comments: false`.

### Assistant errors in the panel

The assistant panel shows the errors of its Agent and its Connection, such as `AGENT_R1016` when the ChatGPT grant is missing. See [ChatGPT plan recovery](/docs/connections/chatgpt#recovery), [Connections limits and errors](/docs/connections/limits-and-errors), and [Errors and diagnostics](/docs/reference/errors-diagnostics).
