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
| `@vite-hub/docs/nuxt` | The Nuxt module. Add it to `modules`. Its types are `DocsModuleOptions`, `DocsSiteOptions`, `DocsStartOptions`, `DocsCommentsOptions`, and `DocsPublicConfig`. |
| `@vite-hub/docs` | The frontmatter schema, the manifest types, and the navigation helpers. |
| `@vite-hub/docs/navigation` | The navigation helpers only. The root exports them too. |
| `@vite-hub/docs/server` | Read a content folder without Nuxt: `createDocsManifest()`, `DocsContentError`, `createDocsParser()`, `docsSearchSections()`, `toRawMarkdown()`, and `docsPageResponse()`. |
| `@vite-hub/docs/assistant` | `docsAssistant`, `docsRateLimit()`, `docsPageFromBody()`, and `docsPageContextKey`. It needs `@vite-hub/agent`. |

Apps that use `vite-hub` can import `vite-hub/docs` and `vite-hub/docs/assistant`. They re-export `@vite-hub/docs` and `@vite-hub/docs/assistant`.

## Module options

Set them under `docs` in `nuxt.config.ts`. Every option is optional.

| Option | Type | Default | Use |
| --- | --- | --- | --- |
| `dir` | `string` | `'content'` | Folder of Markdown pages, relative to the app root. |
| `base` | `string` | `'/docs'` | URL prefix whose folders are sections. |
| `site.name` | `string` | `'Docs'` | Name in titles, the rail, llms.txt, and the MCP server. |
| `site.url` | `string` | `''` | Canonical origin, such as `https://lumen.example.com`. Canonical links, raw Markdown links, llms.txt, and the sitemap use it. |
| `site.description` | `string` | `''` | Description of llms.txt. |
| `site.logo` | `string` | None | Path of a one-color SVG beside the name. |
| `site.badge` | `{ label, tooltip? }` | None | A short label after the name, such as `beta`. |
| `categories` | `string[]` | `[]` | Order of section categories in the rail and the catalog. |
| `railExclude` | `string[]` | `[]` | Categories that the catalog lists but the rail leaves out. |
| `groups` | `DocsGroup[]` | `[]` | Rail items that hold several sections. A `DocsGroup` is `{ title, icon?, sections? }`: `sections` lists section ids, and a section can also join with `group` in its `.navigation.yml`. See [Groups](/docs/docs-site/configure#groups). |
| `start` | `{ section, links? }` | None | The section that new readers open first, and site pages listed at its top. The header and the error page link to them. |
| `socials` | `DocsLink[]` | `[]` | Links at the foot of the sidebar. A `DocsLink` is `{ label, to, icon? }`. |
| `banner` | `string` | None | One line above every docs page. |
| `sitemap` | `string[]` | `[]` | More paths for `/sitemap.xml`. Every docs page is in it already. |
| `github` | `{ repo, branch?, dir? }` or `false` | `false` | The repository of the site. The shell links to `https://github.com/<repo>`. `branch` (default `main`) and `dir` (default the `dir` option) are in `useDocsConfig().github` for your own components. |
| `icons` | `Partial<DocsIcons>` | Lucide fallbacks | Icons of the rail and the sidebar: `rail`, `sections`, `pages`, `aliases`, `family`, `page`, and `section`. See [Icons](/docs/docs-site/configure#icons). |
| `mcp` | `{ name?, guide? }` or `false` | On, named after `site.name` | The MCP server at `/mcp`. `guide` is a page that explains how to connect it. |
| `linkChecker` | `false` | On | Checks links on prerendered pages with `nuxt-link-checker` and fails the build on detected errors. Fragment checks are limited to the current page; fragments on other pages are not validated. Remote URLs are not fetched. Set the app's own `linkChecker` options to change this. |
| `ogImage` | `false \| { component? }` | On | Share images, rendered with `nuxt-og-image` while the build prerenders. `component` names the app's own template in `components/OgImage/`, which gets `title`, `description`, `site`, `section`, `logo`, and `host`. `false` turns them off. |
| `assistant` | `boolean` or `{ agent? }` | `false` | The [docs assistant](/docs/docs-site/assistant). `true` uses the Agent named `docs`. |
| `comments` | `boolean` or `{ database?, dialect?, overlay? }` | On with `vite-hub/nuxt` | [Comments](/docs/docs-site/configure#comments) on every page. The object goes to the `comments` option of `vite-hub/nuxt`. `false` sets `comments: false` there, which also keeps the Console from turning Comments on. |
| `rawMarkdown` | `(markdown, page) => string` | None | Rewrites a page before its agent copy is written. It can be async. |
| `parser` | `string` | None | Path of a module whose default export is `DocsParserOptions`, such as `{ plugins }`. The page route, search, and Console drafts parse with it. See [Add Comark plugins](/docs/docs-site/configure#add-comark-plugins). |

The module also sets the options of the modules that it installs: `llms` from `site`, and `agentDiscovery` with the page routes and the MCP server card. Your own `llms` and `agentDiscovery` options win.

## Frontmatter

| Field | Type | Default | Use |
| --- | --- | --- | --- |
| `title` | `string` | Required | Page heading, browser title, and search title. |
| `description` | `string` | None | Text under the heading, the meta description, and the llms.txt entry. |
| `icon` | `string` | `icons.page` | Sidebar icon, as an Iconify name. |
| `layout` | `'article'`, `'tutorial'`, `'landing'`, or `'home'` | `'article'` | See [Layouts](/docs/docs-site/configure#layouts). |
| `tutorial` | `'project'` or `'quickstart'` | None | Stored in the manifest for your own tutorials catalog. |
| `codePanel` | `boolean` | `false` | Tutorials only. Shows the files of the current step beside the prose. |
| `sidebar` | `boolean` | `true` | `false` hides the left navigation on this page. |
| `toc` | `boolean` | `true`, `false` on `landing` and `home` | `false` hides the "On this page" outline. |
| `navigation` | `false` or `{ title?, order?, group?, kind? }` | Listed | `false` keeps the page out of the sidebar. `title` is the sidebar label, `order` sorts the pages, and `group` is a sidebar heading. `kind` is stored in the manifest. |
| `seo` | `{ title?, description?, image? }` | None | Title and description for search engines, shares, and the search dialog, when they must differ from the page. `image` is the share image, a path in `public/` or a URL, or `false` for none; without it the build renders one. |

Dotted keys, such as `navigation.order: 2`, are the same as nested keys. `navigation: false` hides the page even when dotted keys set other navigation fields.

`docsPageSchema` validates these fields, and `docsPageFields` holds one Standard Schema per field.

### Section file

`.navigation.yml` in a section folder. `docsSectionSchema` validates it.

| Field | Type | Default | Use |
| --- | --- | --- | --- |
| `title` | `string` | The title of `index.md`, then the folder name | Section name in the rail, the sidebar, and the catalog. |
| `icon` | `string` | The icon of `index.md`, then `icons.section` | Section icon. |
| `order` | `number` | The folder position | Position in the rail. Lower comes first. |
| `category` | `string` | None | Rail group and catalog group. |
| `group` | `string` | None | Title of the [group](/docs/docs-site/configure#groups) of the section. A `groups` entry that lists the section wins. |
| `related` | `string[]` | `[]` | Section ids under Related in the sidebar. |

## Routes

| Route | From | Content |
| --- | --- | --- |
| Every page path | The catch-all page | The rendered page. Not added when a catch-all page of the app answers every docs page, such as `pages/[...slug].vue`. |
| `/api/_docs/page/<page>.json` | The module | The parsed page, its section, and the previous and next pages. `/api/_docs/page/index.json` is the home page. |
| `/api/_docs/search.json` | The module | The search index: one entry per `h2` and `h3`. |
| `/raw/<page>.md` | The module | The agent copy of a page. `/raw/index.md` is the home page. |
| `/sitemap.xml` | The module | Every page and the `sitemap` paths. |
| `/llms.txt`, `/llms-full.txt` | `nuxt-llms` | The page index and every page in one file. |
| `/sitemap.md`, `/.well-known/api-catalog`, `/robots.txt` | `nuxt-agent-discovery` | The Markdown sitemap, the API catalog, and the AI crawler policy. |
| `/.well-known/skills/index.json`, `/.well-known/skills/<name>/SKILL.md` | `nuxt-agent-discovery` | The Agent Skills of the `skills/` folder, when the app has one. |
| `/mcp` | `@nuxtjs/mcp-toolkit` | The MCP server with `list-pages` and `get-page`. Not added with `mcp: false`. |
| `/.well-known/mcp/server-card.json` | `nuxt-agent-discovery` | The MCP server card. Not added with `mcp: false`. |
| `/api/_vitehub/agents/<agent>/chat` | `vite-hub/nuxt` | The assistant chat, with `assistant` on. |
| `/api/_vitehub/comments/**`, `/_vitehub/page/session` | `vite-hub/nuxt` | The Comments API and the page tools session, unless `comments: false`. |

A production build prerenders every page, its page JSON, the search index, `/sitemap.xml`, and `/sitemap.md`, and follows the links between pages.

## App aliases

| Alias | Content |
| --- | --- |
| `#docs/manifest` | The manifest. The app and the server import the same file. |
| `#docs/navigation` | The navigation helpers. |
| `#docs/components` | The Markdown block components, by name. |

## Inspect

The module writes its outputs to the Nuxt build folder:

| File | Content |
| --- | --- |
| `.nuxt/docs/manifest.mjs` | Every section and page, with the resolved title, path, file, layout, order, group, and flags. |
| `.nuxt/docs/raw/` | The agent copy of each page, as `/raw` serves it. |
| `.nuxt/docs/components.mjs` | The Markdown blocks that pages can use, and their files. |

To read the manifest without Nuxt, for example in a test, call `createDocsManifest()`. It throws `DocsContentError` on the first invalid file, like the build:

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
| `docsRateLimit(options?)` | The question limit, with the id `docs-rate-limit`. `limit` (default `30`), `window` (default `'1h'`), `identity` (default the whole site), and `trustedIpHeaders`. Counters are in process memory. |
| `docsPageFromBody(body)` | The open page path from a chat request body, or `''` when it is missing or not a plain path. |
| `docsPageContextKey` | The Invocation context key that holds the open page path: `'docsPage'`. |
