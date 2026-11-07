---
title: Docs site server API
description: The imports of @vite-hub/docs, every module option and frontmatter field, the routes and files that the module adds, and how to inspect them.
navigation.title: Server API
navigation.order: 5
icon: i-lucide-code-2
---

## Imports

| Import | Use |
| --- | --- |
| `@vite-hub/docs/nuxt` | The Nuxt module for `modules`. Types: `DocsModuleOptions`, `DocsSiteOptions`, `DocsStartOptions`, `DocsCommentsOptions`, and `DocsPublicConfig`. |
| `@vite-hub/docs` | The frontmatter schema, the manifest types, and the navigation helpers. |
| `@vite-hub/docs/navigation` | Only the navigation helpers, which the root also exports. |
| `@vite-hub/docs/server` | Read a content folder without Nuxt: `createDocsManifest()`, `DocsContentError`, `createDocsParser()`, `docsSearchSections()`, `toRawMarkdown()`, and `docsPageResponse()`. |
| `@vite-hub/docs/assistant` | `docsAssistant`, `docsRateLimit()`, `docsPageFromBody()`, and `docsPageContextKey`. It needs `@vite-hub/agent`. |

Apps with `vite-hub` can import `vite-hub/docs` and `vite-hub/docs/assistant`, which re-export `@vite-hub/docs` and `@vite-hub/docs/assistant`.

## Module options

Set these under `docs` in `nuxt.config.ts`. All are optional.

| Option | Type | Default | Use |
| --- | --- | --- | --- |
| `dir` | `string` | `'content'` | Folder of Markdown pages, relative to the app root. |
| `base` | `string` | `'/docs'` | URL prefix whose folders are sections. |
| `site.name` | `string` | `'Docs'` | Name in titles, the rail, llms.txt, and the MCP server. |
| `site.url` | `string` | `''` | Canonical origin, such as `https://lumen.example.com`, for canonical links, raw Markdown links, llms.txt, and the sitemap. |
| `site.description` | `string` | `''` | llms.txt description. |
| `site.logo` | `string` | None | One-color SVG path shown beside the name. |
| `site.badge` | `{ label, tooltip? }` | None | A short label after the name, such as `beta`. |
| `categories` | `string[]` | `[]` | Order of section categories in the rail and the catalog. |
| `railExclude` | `string[]` | `[]` | Categories that the catalog lists but the rail leaves out. |
| `groups` | `DocsGroup[]` | `[]` | Rail items that hold several sections. A `DocsGroup` is `{ title, icon?, sections? }`. `sections` lists section ids; a section can also join with `group` in its `.navigation.yml`. See [Groups](/docs/docs-site/configure#groups). |
| `start` | `{ section, links? }` | None | The section new readers open first, plus site pages listed at its top. The header and error page link to them. |
| `socials` | `DocsLink[]` | `[]` | Community links in the header, or its menu on narrow screens. A `DocsLink` is `{ label, to, icon? }`. |
| `banner` | `string` | None | One line above every docs page. |
| `sitemap` | `string[]` | `[]` | Extra paths for `/sitemap.xml`, which already lists every docs page. |
| `github` | `{ repo, branch?, dir? }` or `false` | `false` | The site repository. The shell links to `https://github.com/<repo>`. `branch` (default `main`) and `dir` (default: the `dir` option) are in `useDocsConfig().github` for your components. |
| `icons` | `Partial<DocsIcons>` | Lucide fallbacks | Rail and sidebar icons: `rail`, `sections`, `pages`, `aliases`, `family`, `page`, and `section`. See [Icons](/docs/docs-site/configure#icons). |
| `mcp` | `{ name?, guide? }` or `false` | On, named after `site.name` | The MCP server at `/mcp`. `guide` is a page that explains how to connect. |
| `linkChecker` | `false` | On | Checks links on prerendered pages with `nuxt-link-checker` and fails the build on errors. It checks fragments only on the current page and does not fetch remote URLs. A link to an exact `redirect` route rule passes; the build stops with [`DocsRedirectError`](/docs/docs-site/limits-and-errors#docsredirecterror) when such a rule leads to no docs page or hides one. Change this with the app's own `linkChecker` options. |
| `ogImage` | `false \| { component? }` | On | Share images, rendered by `nuxt-og-image` during prerender. `component` names your template in `components/OgImage/`, which gets `title`, `description`, `site`, `section`, `logo`, and `host`. `false` turns them off. |
| `assistant` | `boolean` or `{ agent? }` | `false` | The [docs assistant](/docs/docs-site/assistant). `true` uses the Agent named `docs`. |
| `comments` | `boolean` or `{ database?, dialect?, overlay? }` | On with `vite-hub/nuxt` | [Comments](/docs/docs-site/configure#comments) on every page. The object goes to `vite-hub/nuxt`'s `comments` option. `false` sets `comments: false` there. |
| `rawMarkdown` | `(markdown, page) => string` | None | Rewrites a page before its agent copy is written. Can be async. |
| `parser` | `string` | None | Path of a module that default-exports `DocsParserOptions`, such as `{ plugins }`. The page route, search, and Console drafts use it. See [Add Comark plugins](/docs/docs-site/configure#add-comark-plugins). |

The module also configures the modules it installs: `llms` from `site`, and `agentDiscovery` with the page routes and MCP server card. Your own `llms` and `agentDiscovery` options win.

## Frontmatter

| Field | Type | Default | Use |
| --- | --- | --- | --- |
| `title` | `string` | Required | Page heading, browser title, and search title. |
| `description` | `string` | None | Text under the heading, the meta description, and the llms.txt entry. |
| `tagline` | `string` | `description` | Text under the heading when it must differ from the meta description. `description` keeps its other uses. |
| `eyebrow` | `string` | none | Short label above the title, such as the documented package. |
| `credits` | `string` | None | Inline Markdown at the page end, such as projects the page builds on. The page route returns it parsed as `credits`. |
| `keywords` | `string` or `string[]` | None | Extra search words. One string splits at commas. Search ranks them like headings, below the title. |
| `icon` | `string` | `icons.page` | Sidebar icon, as an Iconify name. |
| `layout` | `'article'`, `'tutorial'`, `'landing'`, or `'home'` | `'article'` | See [Layouts](/docs/docs-site/configure#layouts). |
| `tutorial` | `'project'` or `'quickstart'` | None | Stored in the manifest for your tutorials catalog. |
| `codePanel` | `boolean` | `false` | Tutorials only. Shows the current step's files beside the text. |
| `sidebar` | `boolean` | `true` | `false` hides the left navigation on this page. |
| `toc` | `boolean` | `true`, `false` on `landing` and `home` | `false` hides the "On this page" outline. |
| `navigation` | `false` or `{ title?, order?, group?, kind? }` | Listed | `false` hides the page from the sidebar. `title` is the sidebar label, `order` sorts pages, `group` is a sidebar heading, and `kind` is stored in the manifest. |
| `seo` | `{ title?, description?, image? }` | None | Title and description for search engines, shares, and the search dialog, when they differ from the page. `image` is the share image: a path in `public/`, a URL, or `false` for none. Without it, the build renders one. |

Dotted keys, such as `navigation.order: 2`, equal nested keys. `navigation: false` hides the page even when dotted keys set other navigation fields.

`docsPageSchema` validates these fields, and `docsPageFields` holds one Standard Schema per field.

### Section file

A `.navigation.yml` in a section folder, validated by `docsSectionSchema`.

| Field | Type | Default | Use |
| --- | --- | --- | --- |
| `title` | `string` | `index.md` title, then folder name | Section name in the rail, the sidebar, and the catalog. |
| `icon` | `string` | `index.md` icon, then `icons.section` | Section icon. |
| `order` | `number` | The folder position | Rail position. Lower comes first. |
| `category` | `string` | None | Rail group and catalog group. |
| `group` | `string` | None | Title of the section's [group](/docs/docs-site/configure#groups). A `groups` entry that lists the section wins. |
| `fold` | `boolean` | `false` | Folds each sidebar page group. See [Fold page groups](/docs/docs-site/configure#fold-page-groups). |
| `related` | `string[]` | `[]` | Section ids under Related in the sidebar. |

## Routes

| Route | From | Content |
| --- | --- | --- |
| Every page path | The catch-all page | The rendered page. Skipped when an app catch-all page, such as `pages/[...slug].vue`, answers every docs page. |
| `/api/_docs/page/<page>.json` | The module | The parsed page, its section, and the previous and next pages. `/api/_docs/page/index.json` is the home page. |
| `/api/_docs/search.json` | The module | The search index: one entry per `h2` and `h3`. |
| `/raw/<page>.md` | The module | The agent copy of a page. `/raw/index.md` is the home page. |
| `/sitemap.xml` | The module | Every page and the `sitemap` paths. |
| `/llms.txt`, `/llms-full.txt` | `nuxt-llms` | The page index and every page in one file. |
| `/sitemap.md`, `/.well-known/api-catalog`, `/robots.txt` | `nuxt-agent-discovery` | The Markdown sitemap, the API catalog, and the AI crawler policy. |
| `/.well-known/skills/index.json`, `/.well-known/skills/<name>/SKILL.md` | `nuxt-agent-discovery` | Agent Skills from the `skills/` folder, if the app has one. |
| `/mcp` | `@nuxtjs/mcp-toolkit` | The MCP server with `list-pages` and `get-page`. Not added with `mcp: false`. |
| `/.well-known/mcp/server-card.json` | `nuxt-agent-discovery` | The MCP server card. Not added with `mcp: false`. |
| `/api/_vitehub/agents/<agent>/chat` | `vite-hub/nuxt` | The assistant chat, with `assistant` on. |
| `/api/_vitehub/comments/**`, `/_vitehub/page/session` | `vite-hub/nuxt` | The Comments API and the page tools session, unless `comments: false`. |

A production build prerenders every page, its page JSON, the search index, `/sitemap.xml`, and `/sitemap.md`, and follows links between pages.

## App aliases

| Alias | Content |
| --- | --- |
| `#docs/manifest` | The manifest. App and server import the same file. |
| `#docs/navigation` | The navigation helpers. |
| `#docs/components` | The Markdown block components, by name. |

## Inspect

The module writes its output to the Nuxt build folder:

| File | Content |
| --- | --- |
| `.nuxt/docs/manifest.mjs` | Every section and page, with the resolved title, path, file, layout, order, group, and flags. |
| `.nuxt/docs/raw/` | The agent copy of each page, as `/raw` serves it. |
| `.nuxt/docs/components.mjs` | The Markdown blocks that pages can use, and their files. |

To read the manifest without Nuxt, for example in a test, call `createDocsManifest()`. Like the build, it throws `DocsContentError` on the first invalid file:

```ts [scripts/docs-pages.ts]
import { createDocsManifest } from '@vite-hub/docs/server'

const manifest = createDocsManifest({ dir: 'content', base: '/docs' })
for (const section of manifest.sections) {
  console.log(section.id, section.pages.map(page => page.path))
}
```

A running site serves the parsed page at `/api/_docs/page/<page>.json` and the agent copy at `/raw/<page>.md`.

## Assistant exports

| Export | Use |
| --- | --- |
| `docsAssistant` | The Agent preset. Extend it with `defineAgent({ extends: docsAssistant })`. See [What the preset sets](/docs/docs-site/assistant#what-the-preset-sets). |
| `docsRateLimit(options?)` | The question limit, id `docs-rate-limit`. Options: `limit` (default `30`), `window` (default `'1h'`), `identity` (default: the whole site), and `trustedIpHeaders`. Counters live in process memory. |
| `docsPageFromBody(body)` | The open page path from a chat request body, or `''` if missing or not a plain path. |
| `docsPageContextKey` | The Agent run context key for the open page path: `'docsPage'`. |
