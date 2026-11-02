# @vite-hub/docs

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fdocs&icon=npm)](https://www.npmjs.com/package/@vite-hub/docs)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs/docs-site)

`@vite-hub/docs` turns a folder of Markdown files into a documentation site. It is a Nuxt module. It gives you the docs shell, three page layouts, search, a Markdown copy of each page for agents, llms.txt, an MCP server, and an optional docs assistant. [vitehub.dev](https://vitehub.dev) runs on it.

You write Markdown. The defaults give you a complete site. When a default does not fit, you change one option, one frontmatter field, or one component.

## Install

```sh
pnpm add @vite-hub/docs nuxt @nuxt/ui tailwindcss
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@vite-hub/docs/nuxt"],
  docs: {
    site: { name: "Acme", url: "https://docs.acme.dev" },
  },
})
```

The module installs Nuxt UI, `@vite-hub/ui`, `nuxt-llms`, `nuxt-agent-discovery`, and `@nuxtjs/mcp-toolkit` for you. Do not add them to `modules`. Set `site.url` to the public origin: llms.txt, canonical links, and the raw Markdown links use it.

The shell uses Lucide, Phosphor, Simple Icons, and VS Code Icons. Install `@iconify-json/lucide`, `@iconify-json/ph`, `@iconify-json/simple-icons`, and `@iconify-json/vscode-icons` to serve them from your app. Without them, `@nuxt/icon` gets them from the Iconify API.

Apps that use `vite-hub` can import the root and the assistant from `vite-hub/docs` and `vite-hub/docs/assistant`.

## Content

```txt
content/
  index.md                    → /
  about.md                    → /about
  docs/
    index.md                  → /docs
    guide/
      .navigation.yml         section title, icon, order, category
      index.md                → /docs/guide
      install.md              → /docs/guide/install
```

`content/docs/index.md` is the page at `/docs`. Without it, `/docs` is not found. Each folder under `content/docs/` is a section: one entry in the rail and its own sidebar. Pages outside `content/docs/`, such as `about.md`, render as plain articles under the site header. `dir` changes the content folder and `base` changes the `/docs` prefix.

The module reads the folder at build time. In development it watches the folder: a body edit shows on the next page load, and a new page, title, or order restarts the app.

### Frontmatter

| Field | Default | Use |
| --- | --- | --- |
| `title` | Required | Page heading and browser title. |
| `description` | None | Text under the heading, the meta description, and the llms.txt entry. |
| `icon` | `i-lucide-file-text` | Sidebar icon, as an Iconify name. |
| `layout` | `article` | `article`, `tutorial`, or `landing`. |
| `sidebar` | `true` | `false` hides the left navigation on this page. |
| `toc` | `true`, `false` on `landing` | `false` hides the "On this page" outline. |
| `codePanel` | `false` | Tutorials only. Shows the files of the current step beside the prose. |
| `tutorial` | None | Tutorials only. `project` or `quickstart`, for your own tutorial catalog. |
| `navigation` | Listed | `false` keeps the page out of the sidebar. Or `{ title, order, group, kind }`. |
| `seo` | None | `{ title, description }` for search results when they must differ from the page. |

Dotted keys work too, such as `navigation.order: 2`. A wrong field stops the build with `DocsContentError`. In development, the terminal shows the error and the site keeps the last valid pages until you fix the file.

`.navigation.yml` in a section folder:

| Field | Use |
| --- | --- |
| `title` | Section name. Defaults to the title of `index.md`, then to the folder name. |
| `icon` | Section icon. |
| `order` | Position in the rail. Lower comes first. |
| `category` | Rail group and catalog group. List the categories in the `categories` option to order them. |
| `related` | Section ids listed under Related in the sidebar. |

## Layouts and rails

- `article` is prose with the outline on the right.
- `tutorial` numbers each `::tutorial-step` block. With `codePanel: true`, a sticky panel on wide screens shows the file tree and the file that the reader is on. Code blocks named `commands/...` or `output/...`, and shell blocks, stay in the prose.
- `landing` is a wide Overview page without the outline. A section Overview ends with the catalog of every section.

The left navigation (the section rail and the page sidebar) and the right outline show on every docs page. Turn them off for one page with `sidebar: false` or `toc: false`. A code panel tutorial starts with the navigation closed; the reader opens it with the button in the top left corner.

````md
---
title: Build a CLI
layout: tutorial
codePanel: true
---

::tutorial-step{title="Create the project"}
## Create the project

```ts [src/cli.ts]
console.log("hello")
```
::
````

## Customize

Most changes are options in `nuxt.config.ts`:

| Option | Default | Use |
| --- | --- | --- |
| `dir` | `content` | Folder of Markdown pages. |
| `base` | `/docs` | URL prefix whose folders are sections. |
| `site` | `{ name: "Docs" }` | `name`, `url` (canonical origin), `description`, `logo` (one-color SVG path), `badge` (`{ label, tooltip }`). |
| `theme` | `vercel` | The only theme today. |
| `categories` | `[]` | Order of section categories in the rail and the catalog. |
| `railExclude` | `[]` | Categories that the catalog lists but the rail leaves out. |
| `start` | None | `{ section, links }`: the section that new readers open first, and site pages listed at its top. |
| `socials` | `[]` | Community links at the foot of the sidebar. |
| `banner` | None | One line above every docs page. |
| `github` | `false` | `{ repo, branch, dir }`. Adds GitHub links to the header and the sidebar. |
| `icons` | Lucide fallbacks | Icon maps of the rail and the sidebar. |
| `sitemap` | `[]` | More paths for `/sitemap.xml`. Every docs page is listed already. |
| `mcp` | On | `{ name, guide }`, or `false` to turn off the MCP server. |
| `assistant` | `false` | `true`, or `{ agent }`. See [Docs assistant](#docs-assistant). |
| `rawMarkdown` | None | `(markdown, page) => string`. Rewrites a page before agents read it. |

### Components

The shell is a set of Nuxt components. Create a component with the same name in your app, and it replaces the default. For example, `app/components/DocsPageHeaderLinks.vue` replaces the page actions.

| Component | Part |
| --- | --- |
| `AppHeader` | Site header on narrow screens and on pages outside the docs. |
| `AppSearch` | The search dialog. |
| `DocsRail`, `DocsSidebars`, `DocsAsideLeftTop`, `DocsAsideLeftBody`, `DocsAsideFooter` | The section rail, the page sidebar, and its footer. |
| `DocsPage`, `DocsArticle`, `DocsLanding`, `DocsMarkdown` | The page and its layouts. |
| `DocsPageHeaderLinks` | Copy page, View as Markdown, Open in ChatGPT or Claude, and the MCP links. |
| `DocsCatalogFooter` | The catalog at the end of an Overview. |
| `DocsCodePanel`, `DocsCodePre` | The tutorial code panel and code blocks. |

Markdown blocks are components in `components/content/`. The package has `::tutorial-step`, `::product-features` with `:::product-feature-item`, and `::agent-only`. Add your own in `app/components/content/`, for example `ProductHero.vue` for `::product-hero`. An app `app.vue`, `error.vue`, `layouts/docs.vue`, `layouts/default.vue`, or catch-all page also replaces the package one.

Components read the site with auto-imported composables: `useDocsConfig()`, `useDocsManifest()`, `useDocsPage()`, `useDocsSection()`, `useDocsIcons()`, and `useDocsAssistant()`.

### Theme

`vercel` is black, white, and zinc, with Geist, square corners, and hairline borders. Change it in two places:

- `app.config.ts` `ui` keys. Your values win over the theme.
- CSS variables in your stylesheet, such as `--vh-content-width` (prose width), `--vh-toc-width`, `--vh-panel-width`, `--font-sans`, and the Nuxt UI `--ui-*` colors.

## Agent resources

Every page has a Markdown copy for coding agents. You get these routes with no setup:

| Route | Content |
| --- | --- |
| `/raw/<page>.md` | The page as Markdown, with absolute links. `::agent-only` blocks stay in it. |
| `/llms.txt`, `/llms-full.txt` | An index of every page, and every page in one file. |
| `/sitemap.md`, `/sitemap.xml` | Every page, for agents and for search engines. |
| `/mcp` | An MCP server with the `list-pages` and `get-page` tools. |
| `/.well-known/skills/<name>/SKILL.md` | Agent Skills from the `skills/` folder of the app, when it has one. |

`::agent-only` content shows only to agents. The site renders nothing for it, and search skips it. Use `rawMarkdown` to expand your own components into plain Markdown in the agent copy. Each page header links to its Markdown copy and opens it in ChatGPT or Claude.

## Search

Search indexes every page by heading. `⌘K` opens it. The index loads the first time the dialog opens, from `/api/_docs/search.json`. `::agent-only` content is not indexed.

## Docs assistant

The docs assistant answers reader questions from your pages and links the pages that it used. It is a ViteHub Agent preset, `docsAssistant`. By default it runs Codex on your ChatGPT plan, so you need no API key.

```sh
pnpm add vite-hub @vite-hub/agent @vite-hub/database drizzle-orm @openai/codex
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: [
    ["vite-hub/nuxt", { preset: "node", agent: true, connections: true, database: true }],
    "@vite-hub/docs/nuxt",
  ],
  docs: { assistant: true },
})
```

```ts
// server/agents/docs.ts
import { docsAssistant } from "@vite-hub/docs/assistant"
import { defineAgent } from "vite-hub/agent"

export default defineAgent({ extends: docsAssistant })
```

```ts
// server/connections/chatgpt.ts
import { defineConnection } from "vite-hub/connections"
import { chatgpt } from "vite-hub/connections/chatgpt"

export default defineConnection({
  provider: chatgpt({ appName: "Acme docs", appVersion: "1.0.0" }),
  access: { "agent:docs": { read: true } },
})
```

Set `VITEHUB_CONNECTIONS_KEY` to 32 random bytes in `.env`, start the app, and sign in once with `pnpm vitehub connections connect chatgpt --url http://localhost:3000`. Every page then shows an **Ask** button. `⌘I` (`Ctrl+I` on Windows and Linux) opens and closes the panel, and `Esc` closes it. On wide screens the panel is a column beside the page that you resize from its left edge. On narrow screens it is a sheet. `useDocsAssistant().toggle()` opens the panel from your own control.

The preset reads `content/**/*.md` from a read-only Workspace, answers in the `web` Chat Channel at `/api/_vitehub/agents/docs/chat`, and gets the path of the open page. It allows 30 questions per hour for the whole site, 2 answers at a time, and 8 waiting. Change any part with `defineAgent({ extends: docsAssistant, ... })`, for example `driver: { instructions }`, `driver: { gateway: openai(), model }` for an API key, or `docsRateLimit({ limit, identity })`. Set `docs: { assistant: { agent: "support" } }` to use an Agent with another name.

Limits:

- **Node.js host only.** Codex runs as a local process. A production build for Cloudflare or another non-Node Nitro preset fails with `DocsAssistantSetupError` while `assistant` is on.
- **ChatGPT plan in the development server only.** `vite-hub/nuxt` does not support Connections in production builds yet. An API key gateway does not need Connections.
- **Plan use.** OpenAI allows plan usage for open-source projects, personal apps that run locally, and selected private apps. Paid or remotely hosted apps must join OpenAI's waitlist first.
- **Shell access.** Codex reads the pages with shell commands in a temporary copy. It cannot write outside that copy or use the network, but it can read other files that the server user can read, and a reader can ask for them. Run a public assistant as a user that can read only the app.
- **Rate limit and budget.** The default limit is in process memory. It resets on restart, does not span processes, and one reader can use the whole hour. The token budget records an answer over 200,000 tokens; it does not stop it.

The [assistant guide](https://vitehub.dev/docs/docs-site/assistant) has every default and option.

## Edit in the Console

The ViteHub Console edits, previews, and publishes pages through the CMS. Add `vite-hub/nuxt` and one file:

```ts
// server/content.ts
import { defineContent } from "vite-hub/content"
import cms from "vite-hub/cms"
import { docsCollection } from "@vite-hub/docs"

export const content = defineContent({
  extends: [cms, { repo: "owner/name", publish: "pr", access: "roles" }],
  collections: { docs: docsCollection() },
})
```

`docsCollection({ path?, label? })` is a `documents()` collection over `content/**/*.md` with the page frontmatter as fields, and each document URL is its page URL. With `repo`, a save commits to a draft branch and a publish opens a pull request, so the site shows the change after it merges and builds. In the Console preview pane the page route renders the draft, uncached. See [Edit in the Console](https://vitehub.dev/docs/docs-site/configure#edit-in-the-console).

## Errors

| Error | When | Fix |
| --- | --- | --- |
| `DocsContentError` | A page frontmatter or a `.navigation.yml` file does not match the schema. The message names the file and the field. | Fix the field. The schema is `docsPageSchema` and `docsSectionSchema` from `@vite-hub/docs`. |
| `DocsAssistantSetupError` | `assistant` is on, and `vite-hub/nuxt` with `agent: true` is missing, or a production build uses a non-Node Nitro preset. | Add `vite-hub/nuxt` with `agent: true` and `connections: true`, build for Node, or turn `assistant` off for that build. |

## Inspect

- The manifest, every section and page with its resolved title, order, layout, and flags, is in `.nuxt/docs/manifest.mjs`. Components read it with `useDocsManifest()`. A script reads it with `createDocsManifest({ dir, base })` from `@vite-hub/docs/server`.
- The agent copy of each page is in `.nuxt/docs/raw/`.
- The Markdown blocks that pages can use are in `.nuxt/docs/components.mjs`.
- A running site serves the parsed page at `/api/_docs/page/<page>.json` and the search index at `/api/_docs/search.json`.

See the [docs site documentation](https://vitehub.dev/docs/docs-site).
