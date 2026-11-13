# @vite-hub/docs

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fdocs&icon=npm)](https://www.npmjs.com/package/@vite-hub/docs)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs/docs-site)

`@vite-hub/docs` turns a folder of Markdown files into a documentation site. It is a Nuxt module. It gives you the docs shell, four page layouts, search, a Markdown copy of each page for agents, llms.txt, an MCP server, and an optional docs assistant. [vitehub.dev](https://vitehub.dev) runs on it.

You write Markdown. The defaults give you a complete site. When a default does not fit, you change one option, one frontmatter field, or one component.

## Install

```sh
pnpm add @vite-hub/docs nuxt @nuxt/ui tailwindcss comark @comark/vue @comark/html comark-ui
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

The module installs Nuxt UI, `@vite-hub/ui`, `nuxt-agent-discovery`, and `nuxt-link-checker` for you. Do not add them to `modules`. Content serves the agent files: `/raw/<page>.md`, `llms.txt`, `llms-full.txt`, `sitemap.md`, `sitemap.xml`, and the MCP server. Set `site.url` to the public origin: llms.txt, canonical links, and the raw Markdown links use it.

The shell uses Lucide, Simple Icons, and VS Code Icons. Install `@iconify-json/lucide`, `@iconify-json/simple-icons`, and `@iconify-json/vscode-icons` to serve them from your app. Without them, `@nuxt/icon` gets them from the Iconify API.

Apps that use `vite-hub` can import the root and the assistant from `vite-hub/docs` and `vite-hub/docs/assistant`.

### Add docs to an existing app

Put the pages in `content/docs/`. The module serves them at `/docs`, and the rest of the site stays the app's:

```txt
content/docs/
  index.md        → /docs
  guide/
    index.md      → /docs/guide
    install.md    → /docs/guide/install
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@nuxt/ui", "@vite-hub/docs/nuxt"],
  docs: { site: { name: "Acme", url: "https://acme.dev" } },
})
```

- The docs page answers only below `/docs`. The app keeps its own pages, its layouts, and its error page, also next to its own `pages/[...slug].vue`.
- The app keeps its `app.vue`. The docs layouts draw the site header, the search, and the page head on docs pages only. The `app.vue` must wrap `<NuxtPage />` in `<UApp>` and `<NuxtLayout>`, as Nuxt UI and Nuxt layouts need. The development server warns when one is missing.
- The build prerenders every docs page and crawls nothing else, so the app's own pages stay server-rendered.
- The docs theme applies to the docs pages only. The app's pages keep its Nuxt UI theme. See [Theme](#theme).

## Content

```txt
content/
  index.md                    → /
  about.md                    → /about
  docs/
    index.md                  → /docs
    guide/
      .navigation.yml         section title, icon, order, category, group, fold
      index.md                → /docs/guide
      install.md              → /docs/guide/install
```

A page's URL is its path in the folder. With a `content/docs/` folder, the docs are at `/docs`. Without one, the docs are the whole site: `content/index.md` is `/`, and each folder in `content/` is a section. `content/docs/index.md` is the page at `/docs`. Without it, `/docs` is not found, and the Docs links open the first section. Each folder under `content/docs/` is a section: one entry in the rail and its own sidebar. A site with three sections or fewer, or with no section icons, has no rail: the sidebar lists every section with its pages. Pages outside `content/docs/`, such as `about.md`, render as plain articles under the site header. `dir` changes the content folder, and `base` sets the URL prefix of the sections when the default does not fit.

The module reads the folder at build time. In development it watches the folder: a body edit shows on the next page load, and a new page, title, or order restarts the app.

### Multiple sources and Markdown components

Read pages from more than one place with `sources`. It replaces `dir`. Each entry is a folder relative to the app root, a Source from `vite-hub/source`, such as `glob()` or `github()`, or `{ source, mount?, exclude?, frontmatter? }` with one of them. `mount` is the public path of the pages, `exclude` leaves out file globs, and `frontmatter` adapts metadata before schema validation.

The module reads the `.md` and `.navigation.yml` files of every source through ViteHub Content when it builds. In development the server reads folders through Nitro server assets, and the module watches them. The build copies the pages of any other Source into `.nuxt/docs/sources/docs-<index>/` and serves that copy, so a `github()` Source shows its branch as it was at build time. A production build packs the Markdown and rewritten agent copies into one gzip module to stay below Cloudflare’s module limit. A `glob()` Source lists dot files only when its `include` names them, such as `**/.navigation.yml`, and reads only below the app root.

`sources` configures the site pages, search, and Markdown resources. It does not configure the app-owned `docsAssistant` Agent, whose default Workspace reads `content/**/*.md`. To let the assistant read mapped pages, configure its Workspace sources too, as described in [Docs assistant](#docs-assistant).

```ts
import { github, glob } from "vite-hub/source"

export default defineNuxtConfig({
  modules: ["@vite-hub/docs/nuxt"],
  docs: {
    base: "/",
    sources: [
      { source: "pages", exclude: ["partials/**"] },
      { source: "../packages/zoom/docs", mount: "/zoom" },
      { source: glob({ cwd: "guides", include: ["**/*.md", "**/.navigation.yml"] }), mount: "/guides" },
      { source: github({ repo: "acme/api", root: "docs" }), mount: "/api" },
    ],
    sections: { zoom: { category: "Packages", order: 1 } },
    components: "./markdown-components.ts",
  },
})
```

`sections` overrides `.navigation.yml` fields by section id. A source's synchronous `frontmatter(data, { file, path, markdown })` callback can supply generated titles or migrate legacy fields. Its return value still passes the full docs schema. `file` stays relative to the source; `path` is the public page path.

The `components` module exports a default map of Comark tags to Vue components. Components passed directly to `DocsMarkdown` override that map. Both maps override app blocks in `components/content/`, which override the built-in Comark blocks and load on demand.

### Frontmatter

| Field | Default | Use |
| --- | --- | --- |
| `title` | Required | Page heading and browser title. |
| `description` | None | Text under the heading, the meta description, and the llms.txt entry. |
| `tagline` | `description` | Text under the heading, when it must differ from the meta description. |
| `eyebrow` | none | A short label above the title, such as the package that the page documents. |
| `credits` | None | Inline Markdown at the end of the page, such as `Icons from [Lucide](https://lucide.dev).` |
| `keywords` | None | Words that find the page in search besides its own text: a list, or one string with commas. They rank below the page title and with headings. |
| `icon` | `i-lucide-file-text` | Sidebar icon, as an Iconify name. |
| `layout` | `article` | `article`, `tutorial`, `landing`, or `home`. |
| `sidebar` | `true` | `false` hides the left navigation on this page. `collapsed` starts it as a narrow column that the reader opens. |
| `toc` | `true`, `false` on `landing` | `false` hides the "On this page" outline. |
| `codePanel` | `false` | Tutorials only. Shows the files of the current step beside the prose. |
| `tutorial` | None | Tutorials only. `project` or `quickstart`, for your own tutorial catalog. |
| `navigation` | Listed | `false` keeps the page out of the sidebar. Or `{ title, order, group, kind, panel }`. See [Panels](#panels). |
| `seo` | None | `{ title, description, image, index }` for search results and shares when they must differ from the page. `image` is a path in `public/` or a URL, or `false` for no share image. `index: false` asks search engines not to index the page. See [Pages that search engines skip](#pages-that-search-engines-skip). |

Dotted keys work too, such as `navigation.order: 2`. A wrong field stops the build with `DocsContentError`. In development, the terminal shows the error and the site keeps the last valid pages until you fix the file.

`.navigation.yml` in a section folder:

| Field | Use |
| --- | --- |
| `title` | Section name. Defaults to the title of `index.md`, then to the folder name. |
| `icon` | Section icon. |
| `order` | Position in the rail. Lower comes first. |
| `category` | Rail group and catalog group. List the categories in the `categories` option to order them. |
| `group` | Title of the group of the section. See `groups`. |
| `fold` | `true` folds each page group of the sidebar. The group of the current page opens itself. |
| `related` | Section ids listed under Related in the sidebar. |

### Panels

A long list of pages, such as one page for each error code, would bury the other pages of a section. Set `navigation.panel: true` on the `index.md` of a folder inside the section, and the folder becomes a panel:

- The section sidebar shows one link to the panel, with the number of its pages, after the section pages.
- On a page of the panel, the sidebar lists only the panel: a link back to the section, the panel Overview, and its pages by `navigation.group`. Each group folds. A page title that is a code, such as `QUEUE_DISABLED`, shows in monospace on one line. Search finds the panel pages by title, so the panel has no filter of its own.
- The rail keeps the reader in the panel. On `/docs/queue/diagnostics/queue_disabled`, the KV item opens `/docs/kv/diagnostics` when that folder is a panel too, and `/docs/kv` when it is not.
- Previous and next stay inside the panel.

```md [content/docs/queue/diagnostics/index.md]
---
title: Queue diagnostics
navigation.title: Diagnostics
navigation.panel: true
---
```

### Pages that search engines skip

`seo.index: false` adds `<meta name="robots" content="noindex, follow">` and leaves the page out of `sitemap.xml`, llms.txt, `llms-full.txt`, and the share images. The site search lists it by its title and description only. The build does not prerender the page: the server renders it on request, so a site with thousands of generated pages builds as fast as before. Links to the page stay valid for the link checker, and its raw Markdown copy stays at `/raw/...`. Use it for long tails of thin pages, such as one page for each error code, and keep the page that lists them indexed.

## Layouts and rails

- `article` is prose with the outline on the right.
- `tutorial` numbers each `::tutorial-step` block. With `codePanel: true`, a sticky panel on wide screens shows the file tree and the file that the reader is on. Code blocks named `commands/...` or `output/...`, and shell blocks, stay in the prose.
- `landing` is a wide Overview page without the outline. A section Overview ends with the catalog of every section.
- `home` is the page's own blocks at full width under the site header, with no title, actions, sidebar, or outline. Use it for a product home page built from your `components/content/` blocks; it keeps its search entry, Markdown copy, and share image.

The left navigation (the section rail and the page sidebar) and the right outline show on every docs page. Turn them off for one page with `sidebar: false` or `toc: false`. A page that needs the width, such as a playground, sets `sidebar: collapsed`: wide screens show a narrow column with the logo, a button that opens the navigation, search, and the site links, or the rail on a site that has one. An app page in the docs layout sets it with `definePageMeta({ layout: "docs", sidebar: "collapsed" })`. A code panel tutorial starts collapsed too.

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
| `base` | `/docs`, or `/` without a `docs/` folder | URL prefix whose folders are sections. |
| `site` | `{ name: "Docs" }` | `name`, `url` (canonical origin), `description`, `logo`, `badge` (`{ label, tooltip }`). A `logo` path is a one-color SVG that the theme fills with the text color. `{ light, dark }` shows a colored logo as it is, with `dark` in dark mode. |
| `categories` | `[]` | Order of section categories in the rail and the catalog. |
| `railExclude` | `[]` | Categories that the catalog lists but the rail leaves out. |
| `groups` | `[]` | `[{ title, icon, sections }]`: rail items that hold several sections, such as every component package of a library. The sidebar of a member lists every section of its group, one row per section. A section also joins with `group` in its `.navigation.yml`. |
| `start` | None | `{ section, links }`: the section that new readers open first, and site pages listed at its top. |
| `socials` | `[]` | Community links at the foot of the docs sidebar and in the header of other pages, or in its menu on narrow screens. |
| `footer` | `[]` | Site pages linked at the end of every docs page, such as About and Privacy. |
| `banner` | None | One line above every docs page. |
| `github` | `false` | `{ repo, branch, dir }`. Adds a GitHub link beside the socials, with the star count when available. |
| `icons` | Lucide fallbacks | Icon maps of the rail and the sidebar. |
| `sitemap` | `[]` | More paths for `/sitemap.xml`. Every docs page is listed already. |
| `mcp` | On | `{ name, guide }`, or `false` to turn off the MCP server. |
| `llms` | None | `{ details, sections }`. Text under the description of `/llms.txt`, and sections of links before the page sections. |
| `linkChecker` | On | `false` turns off `nuxt-link-checker`, which fails the build on detected link errors in prerendered pages. Fragments on other pages are checked against the final built HTML. Remote URLs are not fetched. A link to an exact `redirect` route rule passes, and the build checks that the rule leads to a docs page instead. Set the app's own `linkChecker` options to change it. |
| `seoAudit` | `"warn"` | The search check of prerendered pages. `"warn"` logs the problems, `"error"` or `true` stops the build with `DocsSeoError`, and `false` turns it off. It reports a sitemap URL that is not a prerendered page, a title or description that is missing, shared, or outside 10 to 60 and 70 to 160 characters, and a page that has no single `h1`, skips a heading level, has fewer than 150 words, or has no link to it. |
| `ogImage` | On | Share images. `{ component }` renders the app's own template from `components/OgImage/`, or `false` turns them off. See [Search and share](#search-and-share). |
| `assistant` | `false` | `true`, or `{ agent }`. See [Docs assistant](#docs-assistant). |
| `comments` | On with `vite-hub/nuxt` | `false` turns Comments off, or `{ database, dialect, overlay }`. See [Comments](#comments). |
| `rawMarkdown` | None | `(markdown, page) => string`. Rewrites a page before agents read it. |
| `parser` | None | Path of a module whose default export is the parser options: `{ comarkUi, examples, plugins }`. See [Comark plugins](#comark-plugins). |
| `examples` | `examples` | Folder, inside `app/`, of the Vue files that `::example{name}` shows. See [Examples](#examples). |

### Components

The shell is a set of Nuxt components. Create a component with the same name in your app, and it replaces the default. For example, `app/components/DocsPageHeaderLinks.vue` replaces the page actions.

| Component | Part |
| --- | --- |
| `AppHeader` | Site header, with search, GitHub, social links, and the color mode button. On wide screens it hides beside the docs sidebar. |
| `AppSearch` | The search dialog. |
| `DocsRail`, `DocsSidebars`, `DocsAsideLeftTop`, `DocsAsideLeftBody`, `DocsAsideFooter` | The section rail, the page sidebar with its brand, search, and title, and the row of links at its foot. |
| `DocsPage`, `DocsArticle`, `DocsLanding`, `DocsMarkdown` | The page and its layouts. |
| `DocsHeaderActions` | Empty. Replace it to add items to the site header or the desktop sidebar footer. |
| `DocsPageHeaderLinks` | Copy page, View as Markdown, Open in ChatGPT or Claude, and the MCP links. |
| `DocsCatalogFooter` | The catalog at the end of an Overview. |
| `DocsCodePanel`, `DocsCodePre` | The tutorial code panel and code blocks. |

Markdown blocks are components in `components/content/`. The package has `::tutorial-step`, `::product-features` with `:::product-feature-item`, `::example` and `::examples`, `::correct` and `::incorrect`, `::code-tree`, `::page-list`, and `::agent-only`. Add your own in `app/components/content/`, for example `ProductHero.vue` for `::product-hero`. An app `app.vue`, `error.vue`, `layouts/docs.vue`, or `layouts/default.vue` also replaces the package one. In an app with its own `app.vue`, the plain articles outside the sections use the `docs-article` layout, so the app's `default` layout stays on its own pages. A catch-all page replaces the docs page only at the docs prefix: `pages/[...slug].vue` for docs at `/`, and `pages/docs/[...slug].vue` for docs at `/docs`. One at another prefix, such as `pages/blog/[...slug].vue`, does not.

A replacement docs layout or sidebar keeps the site header. Render `<DocsSidebars panel head />` to supply the sidebar controls and hide the desktop header. A replacement `DocsSidebars` can opt in with `data-docs-sidebar-head` on its root after it supplies the brand, badge tooltip, search, and `<DocsAsideFooter />`. The header owns one `DocsHeaderActions` instance and moves it into the mounted footer on wide screens.

Components read the site with auto-imported composables: `useDocsConfig()`, `useDocsManifest()`, `useDocsPage()`, `useDocsSection()`, `useDocsIcons()`, and `useDocsAssistant()`.

A Vue entry holds the parts that docs pages share with other ViteHub surfaces. Their styles are in `@vite-hub/ui/styles.css`, which the module loads.

| Entry | Parts |
| --- | --- |
| `@vite-hub/docs/primitive-rail` | `PrimitiveRail`, `PrimitiveRailGroup`, `PrimitiveRailItem`, and `PrimitiveIcon`, which draws a [`@vite-hub/icons`](../icons/README.md) icon inline so its rail item can move it on hover. The docs rail and the Console use them. They are internal and can change in any release. |

### Examples

`::example` shows a preview and its source, with a Preview and Code switch. Around an `md`, `markdown`, `mdc`, or `comark` code block, the preview is that Markdown, rendered with the same plugins as the page:

`````md
::example
````md
Some **bold** text.
````
::
`````

With `name`, the preview is a Vue file in `app/examples/`, and Code shows its source. `::example{name="ButtonExample"}` renders `app/examples/ButtonExample.vue`. `height` keeps that many rem for it before its module loads, `flush` shows it edge to edge at that height, and `reset` adds a control that mounts it again. `play` links the example to a playground that opens it.

`::examples` puts several `:::example` blocks in underlined tabs named by their `label`. The examples share one view, so a reader who picks Code keeps reading code from tab to tab. A site that renders the preview itself, as comark-ui does to write `play`, passes a parser plugin named `docs-examples`.

`::correct` and `::incorrect` are examples titled Correct and Incorrect, as on a lint rule's page. Any example takes a `#title` slot that leads its bar, and these two fill it; `title` renames them. Markdown that doesn't parse, such as broken frontmatter on purpose, shows its source alone.

### Code trees and page lists

`::code-tree` shows its code blocks as a project: file tabs beside the open file, or above it in a narrow panel. Each block names its file, such as ```` ```ts [server/api/kv.ts] ````, and `default-value` picks the file that opens first.

`::page-list` lists the pages of the page's section under their sidebar groups, with their icons and descriptions, for an Overview. `section` lists another section, and `exclude="Start"` leaves groups out. Put a plain Markdown list inside it: the site doesn't show it, and agents read it in the Markdown copy.

### Comark plugins

The server parses each page with Comark, and the browser renders the nodes with [comark-ui](https://comark-ui.onmax.me)'s blocks: GitHub callouts (`> [!NOTE]`, and `::note`, `::tip`, `::warning`, `::caution`, `::important`), tabs and code groups, steps, code with a copy bar, zoomable images, charts, diagrams, file trees, cards, and the rest. comark-ui's typeset is off, since the design styles the prose. Chips are off too: they turn every web link into a chip and fetch its favicon. Annotated screenshots, diffs, quizzes, and comments have no Vue components, so the server draws them as HTML in a `comark-html` node, with the block's tag in `block`.

`::examples` and `:::example{label play}` show rendered Markdown next to its source, with underlined tabs, a Preview and Code switch, and an optional link to a playground. The parser renders the example's first fenced block as its preview, with the page's plugins. An example whose Markdown doesn't parse shows its source alone. A site's parser can still supply its own `example-preview` node. Content without a preview node stays visible.

Parser options go in a module that `parser` names, since Comark plugins are functions:

```ts
// docs.parser.ts
import type { DocsParserOptions } from "@vite-hub/docs/server"
import emoji from "comark/plugins/emoji"

export default {
  plugins: [emoji()],
  comarkUi: { chips: true },
  examples: { play: source => `/play#md=${encodeURIComponent(source)}` },
} satisfies DocsParserOptions
```

Set `docs: { parser: "./docs.parser.ts" }`. The page route, search, and Console drafts parse with these options. The page route reads each page with `content.get()` from a Content runtime over the bundled pages, so Content caches the parsed page. To parse docs pages in your own `server/content.ts`, pass `defineContent({ markdown: docsMarkdown(options) })` from `@vite-hub/docs/server`. It turns off Content's own comark-ui preset, so the output is the same as the page route's.

| Option | Default | Use |
| --- | --- | --- |
| `comarkUi` | `{ typeset: false, chips: false, diagrams: false, badge: { download: false } }` | Options of comark-ui's preset, merged over the defaults, such as `{ chips: true }`. `mermaid` fences render as SVG on the server with no network request. `diagrams: true` draws D2, PlantUML, and Graphviz fences through kroki.io, which receives their source; `diagrams: { server }` uses your own Kroki server. When `docs.github` is set, `github.references.repo` defaults to its repository, so `#123` links to its issues. |
| `examples.tags` | `["example", "correct", "incorrect"]` | Tags of the blocks that get a preview of their first fenced block, such as `["example", "correct", "incorrect"]`. |
| `examples.play` | None | `(source, tag) => url`: a playground URL for the block's Markdown, written as its `play`. Return `undefined` for no link. |
| `plugins` | `[]` | More Comark plugins, after the built-in ones. A plugin with a built-in name, such as `alert` or `comark-tabs`, replaces it. A plugin that adds a tag that comark-ui doesn't render needs a component for it in `app/components/content/`. |

### Design

The design follows the comark-ui site on top of the ViteHub design system (`@vite-hub/ui/theme.css` and `vitehubTheme`): Geist, neutral grays, hairline rings, 6px controls and 8px cards, one blue focus ring, a faint grain on the page, and GitHub code colors. On docs pages the sidebar holds the brand, search, a rail of sections or groups next to the page list, and a row at its foot with GitHub, the socials, and the color mode button. Other pages, and phones, get a header with the same parts. Text, code, and focus rings pass WCAG AA in light and dark mode. Change it in two places:

- `app.config.ts` `ui` keys. Your values win over the design. The design wins over the Nuxt UI defaults, also when `@nuxt/ui` comes first in `modules`.
- CSS variables in your stylesheet, such as `--vh-content-width` (prose width), `--vh-toc-width`, `--vh-panel-width`, `--vh-grain` (`none` turns the grain off), `--font-sans`, and the Nuxt UI `--ui-*` colors.

In an app with its own `app.vue`, the theme stays on the docs pages:

- The theme's CSS applies below the `vh-docs` class. The docs layouts put it on `<html>` on docs pages only.
- The docs layouts give the theme's slot classes and default props to Nuxt UI's `<UTheme>`, with the live `app.config.ts` UI values above the design. The app's pages keep their look.
- The docs pages use the app's Nuxt UI colors and icons. To change the docs pages only, set the CSS variables on `:root.vh-docs`.

### Link checks

The build also checks cross-page fragments in the final HTML output. Routes excluded by `routeRules` with `prerender: false` or `nitro.prerender.ignore`, including the enabled ViteHub Console, do not need output files: the server can answer them at request time. Files that do exist still have their fragments checked. More specific `prerender: true` rules remain checked.

`docs.linkChecker` accepts `excludeLinks` for intentionally unchecked URLs, `excludePages` for embedded documents, `ignoreFragments` for pages that use the hash as application state, and `redirect(url)` for application redirects. Lists accept exact public paths, globs such as `/blog/**`, or regular expressions; include `app.baseURL` when it is not `/`. The app's `linkChecker.excludeLinks` and `docs.linkChecker.excludeLinks` are combined. `linkChecker: false` disables both checks. For a standalone output check, use `checkDocsLinks({ dir, siteUrl, appBase?, excludeLinks?, excludePages?, ignoreFragments?, redirect?, isRuntimePath? })` from `@vite-hub/docs/server`; `isRuntimePath(pathname)` identifies server routes whose output files may be absent.

## Agent resources

Every page has a Markdown copy for coding agents. You get these routes with no setup:

| Route | Content |
| --- | --- |
| `/raw/<page>.md` | The page as Markdown, with absolute links. `::agent-only` blocks stay in it. It ends with the pages of its section, the next page, and a link to `/llms.txt`. |
| `/llms.txt`, `/llms-full.txt` | An index of every page, and every page in one file without the section links. |
| `/sitemap.md`, `/sitemap.xml` | Every page, for agents and for search engines. |
| `/mcp` | An MCP server with the `list-pages` and `get-page` tools. |
| `/.well-known/skills/<name>/SKILL.md` | Agent Skills from the `skills/` folder of the app, when it has one. |

Product landing components become plain Markdown, with the hero tagline, hosts, channels, linked feature titles, and descriptions. Component syntax inside code examples stays literal.

`::agent-only` content shows only to agents. The site renders nothing for it, and search skips it. Use `rawMarkdown` to expand your own components into plain Markdown in the agent copy. Each page header links to its Markdown copy and opens it in ChatGPT or Claude.

## Search and share

Every page gets its title, description, canonical link, Open Graph and Twitter tags, Schema.org (`WebSite`, `WebPage`, `TechArticle`, and a breadcrumb), and a share image, from its frontmatter and the `site` options. [Nuxt SEO](https://nuxtseo.com) does the work: `nuxt-site-config` takes `site`, `nuxt-schema-org` writes the graph, and `nuxt-og-image` renders each image while the build prerenders, so the server carries no renderer and a Worker stays small. The default image shows the site, the section, the page title, and the description. A page sets `seo.image` to share a file of its own. For another design, add `components/OgImage/Docs.takumi.vue` with the props `title`, `description`, `site`, `section`, `logo`, and `host`, and set `ogImage: { component: "Docs" }`. An app page, such as a playground, calls `useDocsSeo({ title, description })` to get the same tags and image.

Search indexes every page by heading. `⌘K` opens it. Page titles rank first, then headings, then text, and a typo still finds the page. The index loads the first time the dialog opens, from `/api/_docs/search.json`. `::agent-only` content is not indexed.

## Comments

A docs site on `vite-hub/nuxt` has ViteHub Comments on every page. The team pins comments, replies, mentions people with `@`, and resolves threads. Install `@vite-hub/comments` beside `vite-hub`:

```sh
pnpm add @vite-hub/comments
```

The module sets the `comments` option of `vite-hub/nuxt`, which turns on the Database. Run `vitehub database generate` and `vitehub database migrate` once. No `server/comments.ts` is needed; add one to set `authorize` or `people`.

- A thread belongs to the page path, such as `/docs/kv`, so it stays on its page across deploys.
- Readers see nothing. The overlay loads only with `?vitehub` or the `vitehub-tools` cookie, for people that `authorize` lets read. Without `authorize`, a production build admits the people of the Console's Comments section and people signed in with GitHub who can push to the repository.
- `@` suggests the users of ViteHub Auth when the app has Auth, else the people who wrote in the threads.
- The Console's Comments section lists the threads.

Turn it off with `docs: { comments: false }`. An object goes to the `comments` option of `vite-hub/nuxt`, such as `{ database: "docs" }` or `{ overlay: false }`. A site without `vite-hub/nuxt` has no Comments; `comments: true` there fails the build with `DocsCommentsSetupError`.

## Docs assistant

The docs assistant answers reader questions from your pages and links the pages that it used. It is a ViteHub Agent preset, `docsAssistant`. By default it runs on your ChatGPT plan, so you need no API key: with Codex on Node.js, and with a model-backed Driver in a Cloudflare Worker build.

```sh
pnpm add vite-hub @vite-hub/agent @vite-hub/workflow @vite-hub/connections @vite-hub/database drizzle-orm @openai/codex
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: [
    ["vite-hub/nuxt", { host: "node", agent: true, connections: true, database: true }],
    "@vite-hub/docs/nuxt",
  ],
  docs: { assistant: true },
})
```

```ts
// server/agents/docs.ts
// server/agents/docs/agent.ts. `workspace: {}` says that this Agent owns the pages Workspace of the preset, so a build bundles the pages for hosts without a file system.
import { docsAssistant } from "@vite-hub/docs/assistant"
import { defineAgent } from "vite-hub/agent"

export default defineAgent({ extends: docsAssistant, workspace: {} })
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

```ts
// server/databases/default.ts: Connections keeps the grant in the app Database. Skip it when the app has one.
import { defineDatabase } from "vite-hub/database"

export default defineDatabase({ schema: {} })
```

The Agent and the Connection are app files on purpose. ViteHub discovers Agents and Connections from `server/`, so the ViteHub CLI and the Console show them like every other Agent and Connection. The Connection grants the Agent use of your ChatGPT plan, and a grant of that kind stays in your code, where you can read it. `docs.assistant` only adds the panel and checks this setup.

Set `VITEHUB_CONNECTIONS_KEY` to 32 random bytes in `.env`, start the app, and sign in once with `pnpm vitehub connections connect chatgpt --url http://localhost:3000`. Every page then shows an **Ask** button. `⌘I` (`Ctrl+I` on Windows and Linux) opens and closes the panel, and `Esc` closes it. On wide screens the panel is a column beside the page that you resize from its left edge. On narrow screens it is a sheet. `useDocsAssistant().toggle()` opens the panel from your own control.

The preset reads `content/**/*.md` from a read-only Workspace, answers in the `web` Chat Channel at `/api/_vitehub/agents/docs/chat`, and gets the path of the open page. It allows 30 questions per hour for the whole site, 2 answers at a time, and 8 waiting. Change any part with `defineAgent({ extends: docsAssistant, ... })`, for example `driver: { instructions }`, `driver: { gateway: openai(), model }` for an API key, or `docsRateLimit({ limit, identity })`. Set `docs: { assistant: { agent: "support" } }` to use an Agent with another name.

The preset does not inherit `docs.dir` or `docs.sources`. With another `dir`, import `glob` from `@vite-hub/workspace` and override `workspace: { sources: { pages: glob({ cwd: dir, include: ["**/*.md"], keyCache: false }) } }`. With `sources`, replace the default `pages` Source and add a glob for each folder. Mirror each source's `exclude` as `ignore`, and set each glob's Workspace `mount` to `pages` plus its public mount, such as `pages/zoom`. This keeps file paths aligned with the assistant's page-link instructions. All glob folders must be inside the Workspace's `sourceRootDir`; use a common project root when pages live outside the Nuxt app. Frontmatter adapters apply to site metadata only; the assistant reads the source Markdown.

Limits:

- **Worker builds.** Under the `workerd` and `worker` conditions, `docsAssistant` uses `driver: { model: "gpt-6.1-sol", gateway: chatgpt() }`, because a Worker cannot start Codex. The model reads the pages with the read-only Workspace shell. Change the model with `driver: { model }`, from `vitehub connections models chatgpt`. An Agent that sets `codexDriver()` itself fails a Worker build with `AGENT_B0019`.
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

export default defineContent({
  extends: [cms, { repo: "owner/name", publish: "pr", access: "roles" }],
  collections: { docs: docsCollection() },
})
```

`docsCollection({ path?, label? })` is a `documents()` collection over `content/**/*.md` with the page frontmatter as fields, and each document URL is its page URL. With `repo`, a save commits to a draft branch and a publish opens a pull request, so the site shows the change after it merges and builds. In the Console preview pane the page route renders the draft, uncached. Leave out the Content `seo` option: the docs module serves the sitemap and the Markdown copies, and Content's `.md` copies would compete with them in another format. See [Edit in the Console](https://vitehub.dev/docs/docs-site/configure#edit-in-the-console).

## Errors

| Error | When | Fix |
| --- | --- | --- |
| `DocsContentError` | A page frontmatter or a `.navigation.yml` file does not match the schema. The message names the file and the field. | Fix the field. The schema is `docsPageSchema` and `docsSectionSchema` from `@vite-hub/docs`. |
| `DocsRedirectError` | A production build with the link checker on finds a redirect route rule into the docs that no page answers, or one that hides a docs page. | Point the rule to a page, or remove it. |
| `DocsAssistantSetupError` | `assistant` is on, and `vite-hub/nuxt` with `agent: true` is missing. | Add `vite-hub/nuxt` with `agent: true` and `connections: true`, or turn `assistant` off. |

## Inspect

- The manifest, every section and page with its resolved title, order, layout, and flags, is in `.nuxt/docs/manifest.mjs`. The server reads it. Components read the copy in `.nuxt/docs/app-manifest.mjs` with `useDocsManifest()`: each page has only its `DocsAppPage` fields, such as `title`, `description`, `icon`, and `layout`. The page route returns the other fields of a page, such as `seo`, `tagline`, and `credits`. The build lists the pages and `.navigation.yml` files through ViteHub Content: `createDocsContent()` gives one Content Source per docs source, named `docs_<index>`: a `glob()` Source for a folder, or the Source that `sources` names. A script reads the whole manifest with `await createDocsManifest({ dir, base })`, or `{ dir, base, sources, rootDir }`, from `@vite-hub/docs/server`.
- The agent copy of each page is in `.nuxt/docs/raw/`.
- The Markdown blocks that pages can use are in `.nuxt/docs/components.mjs`.
- A running site serves the parsed page at `/api/_docs/page/<page>.json` and the search index at `/api/_docs/search.json`.

See the [docs site documentation](https://vitehub.dev/docs/docs-site).
