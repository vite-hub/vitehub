---
title: Configure a docs site
description: Organize sections, pick a layout per page, turn the navigation and the outline on or off, change the theme, replace components, and add Markdown blocks.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

Start with the defaults. Each change below is one option in `nuxt.config.ts`, one field in the page frontmatter, or one component in your app. The [Server API](/docs/docs-site/server-api) lists every option and field.

## Organize the content

```txt
content/
  index.md                  /
  about.md                  /about
  docs/
    index.md                /docs
    guide/
      .navigation.yml       section title, icon, order, category, group, fold
      index.md              /docs/guide
      install.md            /docs/guide/install
      deploy/
        index.md            /docs/guide/deploy
```

- Each folder in `content/docs/` is a section: one entry in the rail and one page list in the sidebar. A site with three sections or fewer, or with no section icons, has no rail. Its sidebar lists every section with its pages.
- `index.md` is the page of its folder. `content/docs/index.md` is the page at `/docs`. Without it, `/docs` is not found, and the Docs links open the first section.
- Files outside `content/docs/`, such as `about.md`, are plain articles under the site header, without the sidebar.
- `dir` changes the content folder, and `base` changes the `/docs` prefix.

### Sections and categories

`.navigation.yml` names the section and places it:

```yaml [content/docs/guide/.navigation.yml]
title: Guide
icon: i-lucide-book-open
order: 1
category: Learn
related: [reference]
```

`order` sorts the sections in the rail. `category` groups them. `related` lists other section ids under Related in the sidebar.

List the categories in `categories` to set their order. The rail shows one group per category, and the catalog at the end of each Overview lists every category in `categories`. `railExclude` keeps a category in the catalog but out of the rail, for topics such as shared reference pages.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vite-hub/docs/nuxt'],
  docs: {
    categories: ['Learn', 'Build', 'Reference'],
    railExclude: ['Reference'],
    // The section that new readers open first, and site pages at the top of it
    start: { section: 'guide', links: [{ label: 'All docs', to: '/docs', icon: 'i-lucide-layout-grid' }] },
  },
})
```

A section without a category, or with a category that `categories` does not list, shows in a last rail group and not in the catalog.

### Groups

A library with one section per package can have more sections than a rail can show. A group puts several sections in one rail item. The item opens the first section of the group, and the sidebar of every member lists all the sections of the group: each section is one row that opens its home page, and its other pages follow it. When the sections of a group have different categories, the sidebar shows each category as a heading.

List the sections in `groups`, or set `group` in their `.navigation.yml`:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vite-hub/docs/nuxt'],
  docs: {
    groups: [
      { title: 'Components', icon: 'i-lucide-blocks', sections: ['tabs', 'steps', 'cards'] },
    ],
  },
})
```

```yaml [content/docs/charts/.navigation.yml]
title: Charts
icon: i-lucide-chart-line
category: Data blocks
group: Components
```

The group takes the place of its first section in the rail, and its sections keep their `order`. A group without an `icon` shows the icon of its first section. A `group` that `groups` does not list is a group too, with that title. The sections of one group count as one item when the shell decides whether the site needs a rail.

### Pages in the sidebar

`navigation.order` sorts the pages of a section after its Overview. `navigation.group` puts pages under a label. `navigation.title` is a shorter label than `title`. `navigation: false` keeps a page out of the sidebar; the page still renders at its URL.

```md [content/docs/guide/deploy/index.md]
---
title: Deploy Lumen in CI
navigation.title: Deploy
navigation.group: Operate
navigation.order: 4
---
```

### Fold page groups

A section with many pages, such as one page per lint rule, can fold its page groups. Set `fold: true` in its `.navigation.yml`:

```yaml [content/docs/rules/.navigation.yml]
title: Rules
icon: i-lucide-stethoscope
fold: true
```

Each group with a heading starts shut, and the reader opens it with a click, Enter, or Space. The group that holds the current page opens itself, so its link stays in view. Pages without a group stay open. A [group of sections](#groups) folds the page groups of each section that sets `fold`.

## Layouts

Set `layout` in the frontmatter:

| Layout | Use it for | Shows |
| --- | --- | --- |
| `article` (default) | Guides, concepts, and reference pages | The title, the description, the prose, and the outline. |
| `tutorial` | Steps that build one result | Numbered `::tutorial-step` blocks. With `codePanel: true`, a code panel beside the prose. |
| `landing` | Section Overviews | A wide page without the outline. It ends with the catalog of every section. |
| `home` | A product home page | Only the page's own blocks, at full width under the site header, without the docs sidebar. |

### Tutorials

Put each step in a `::tutorial-step` block. The step heading gets its number from the order of the blocks:

````md [content/docs/guide/first-image.md]
---
title: Compress your first image
layout: tutorial
codePanel: true
---

::tutorial-step{title="Write the config"}
## Write the config

```json [lumen.config.json]
{ "quality": 75 }
```
::
````

With `codePanel: true`, wide screens show a sticky panel beside the prose. It lists every file that the reader has passed, and shows the file of the current step. Name each code block with its path. Blocks named `commands/...` or `output/...`, and `bash` or `sh` blocks, stay in the prose, because they are steps to run, not project files. The panel follows the file names, so give each file one name in the whole tutorial.

`tutorial: project` or `tutorial: quickstart` is stored in the manifest for your own components, such as a tutorials catalog. The shell does not read it.

### Landing pages

A `landing` page has no outline by default. Use `::product-features` with `:::product-feature-item` blocks for a list of linked features:

```md [content/docs/guide/index.md]
---
title: Guide
layout: landing
---

::product-features
  :::product-feature-item{title="Compress a folder" icon="i-lucide-image" to="/docs/guide/install"}
  One command for every image in a folder.
  :::
::
```

## Navigation and outline

The left navigation and the right outline show on every docs page. Turn them off for one page:

| Field | Default | Effect of `false` |
| --- | --- | --- |
| `sidebar` | `true` | Hides the left navigation: the section rail and the page sidebar. |
| `toc` | `true`, and `false` on `landing` pages | Hides the "On this page" outline. |

```md [content/docs/guide/changelog.md]
---
title: Changelog
sidebar: false
toc: false
---
```

A tutorial with `codePanel: true` starts with the navigation closed, so the prose and the code get the width. The reader opens it with the button in the top left corner. A cookie keeps the choice.

## Site options

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vite-hub/docs/nuxt'],
  docs: {
    site: {
      name: 'Lumen',
      url: 'https://lumen.example.com',
      description: 'Resize and compress images from the command line.',
      // A one-color SVG in public/. The theme fills it with the text color.
      logo: '/lumen-mark.svg',
      badge: { label: 'beta', tooltip: 'The CLI flags can change.' },
    },
    banner: 'Lumen 2 is out. Read the upgrade guide.',
    github: { repo: 'acme/lumen' },
    socials: [{ label: 'Lumen on Discord', to: 'https://discord.gg/lumen', icon: 'i-simple-icons-discord' }],
  },
})
```

`github` adds a GitHub link to the header and the sidebar footer. `socials` adds more links to the sidebar footer. `banner` shows one line above every docs page.

## Theme

The theme uses Geist, black, white, and zinc, square corners, hairline borders, and GitHub code colors. Text, code, and focus rings pass WCAG AA in light and dark mode. Change it in two places:

- `app.config.ts`: Nuxt UI `ui` keys. Your values win over the theme. The theme wins over the Nuxt UI defaults, also when `@nuxt/ui` comes first in `modules`.
- CSS variables in a stylesheet of your app:

```css [app/assets/main.css]
:root {
  /* The reading width of prose */
  --vh-content-width: 50rem;
  --vh-toc-width: 14rem;
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
}
```

`--vh-panel-width` sets the width of the page sidebar, and the Nuxt UI `--ui-*` variables set the colors.

### Icons

The shell uses Lucide, Phosphor, Simple Icons, and VS Code Icons. Install `@iconify-json/lucide`, `@iconify-json/ph`, `@iconify-json/simple-icons`, and `@iconify-json/vscode-icons` to serve them from your app. Without them, `@nuxt/icon` gets them from the Iconify API.

The ViteHub icon set is already registered: write `i-vitehub-<name>`, such as `icon: i-vitehub-kv` in a `.navigation.yml` file. The rail draws these icons inline and moves them on hover. The [`@vite-hub/icons`](https://github.com/vite-hub/vitehub/tree/main/packages/icons) README lists every name.

`icons` sets the icons of the navigation:

| Key | Use |
| --- | --- |
| `rail` | Rail icon per section id, such as `i-vitehub-reference`. It replaces the section icon in the rail only. |
| `sections`, `pages` | Sidebar icon per section id or page path. It replaces the icon in the file. |
| `aliases` | Replacement per icon name, so the sidebar keeps one icon style. |
| `family` | Icon prefix of the sidebar, such as `i-ph-`, or a list of prefixes. Other icons that `aliases` does not map show the fallback. |
| `page`, `section` | Fallback icons. |

## Replace a component

The shell is a set of Nuxt components. Create a component with the same name in your app, and the shell uses yours. For example, this file replaces the page actions:

```vue [app/components/DocsPageHeaderLinks.vue]
<script setup lang="ts">
const found = useDocsPage()
const { github } = useDocsConfig()
</script>

<template>
  <UButton
    v-if="found && github"
    :to="`${github.url}/blob/${github.branch}/${github.dir}/${found.page.file}`"
    label="Edit on GitHub"
    variant="ghost"
  />
</template>
```

| Component | Part of the shell |
| --- | --- |
| `AppHeader` | The site header. On wide screens, docs pages show the rail instead. |
| `AppSearch` | The search dialog. |
| `DocsRail` | The section rail. |
| `DocsSidebars`, `DocsAsideLeftTop`, `DocsAsideLeftBody`, `DocsAsideFooter` | The page sidebar and its parts. |
| `DocsPage` | Chooses the layout of a page. |
| `DocsArticle`, `DocsLanding` | The `article` and `tutorial` layouts, and the `landing` layout. |
| `DocsMarkdown`, `DocsCodePre` | The rendered Markdown and its code blocks. |
| `DocsCodePanel` | The tutorial code panel. |
| `DocsPageHeaderLinks` | Copy page, View as Markdown, Open in ChatGPT or Claude, and the MCP links. |
| `DocsCatalogFooter` | The catalog at the end of an Overview. |

The app can also replace `app.vue`, `error.vue`, the `docs` and `default` layouts, and the catch-all page. The module adds its own only when the app has none. A catch-all page replaces the docs page only when it answers every docs page, such as `pages/[...slug].vue`. A catch-all in another folder, such as `pages/blog/[...slug].vue`, does not.

Components read the site with auto-imported composables:

| Composable | Returns |
| --- | --- |
| `useDocsConfig()` | The `docs` options, with every default filled. |
| `useDocsManifest()` | Every section and page. |
| `useDocsPage()` | The page of the current route and its section, or `null`. |
| `useDocsSection()` | The section of the current route. |
| `useDocsIcons()` | The icon of a page, a section, or a rail entry, after the `icons` option. |
| `useDocsAssistant()` | The [assistant](/docs/docs-site/assistant) panel state, and `toggle()`. |

## Add a Markdown block

A Markdown block such as `::tutorial-step` is a component in `components/content/`. Add your own in `app/components/content/`. A file named `Callout.vue` is the `::callout` block. Its props are the attributes of the block, and the slot is its content.

```vue [app/components/content/Callout.vue]
<script setup lang="ts">
defineProps<{ title?: string }>()
</script>

<template>
  <aside class="not-prose border border-default p-4">
    <p v-if="title" class="font-medium">{{ title }}</p>
    <slot />
  </aside>
</template>
```

```md [content/docs/guide/install.md]
::callout{title="Node.js 22"}
Lumen does not run on Node.js 22 or older.
::
```

The package has `::tutorial-step`, `::product-features`, `:::product-feature-item`, and `::agent-only`.

### Add Comark plugins

The server parses every page with [Comark](https://comark.dev). To add Comark plugins, such as a plugin that turns `::code-group` into tabs, put them in a module and name it in `parser`. Plugins are functions, so they cannot go in `nuxt.config.ts` itself.

```ts [docs.parser.ts]
import type { DocsParserOptions } from '@vite-hub/docs/server'
import tabs from 'comark-tabs'

export default { plugins: [tabs()] } satisfies DocsParserOptions
```

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vite-hub/docs/nuxt'],
  docs: { parser: './docs.parser.ts' },
})
```

The page route, search, and Console drafts parse with these plugins after the built-in ones. A plugin with the name of a built-in plugin, such as `alert`, replaces it. The browser receives the parsed nodes, so a plugin that adds a tag needs a component for it in `app/components/content/`.

## Agent resources

Coding agents read the same pages without HTML. You get these routes with no setup:

| Route | Content |
| --- | --- |
| `/raw/<page>.md` | The page as Markdown, with its title as a heading and absolute links. |
| `/llms.txt` | An index of every page with its description. |
| `/llms-full.txt` | Every page in one file. |
| `/sitemap.md` | Every page, for agents. `/sitemap.xml` is the same list for search engines. |
| `/mcp` | An MCP server with the `list-pages` and `get-page` tools. |
| `/.well-known/skills/<name>/SKILL.md` | Each Agent Skill in the `skills/` folder of the app. |

Each page header has **Copy page**, **View as Markdown**, **Open in ChatGPT**, and **Open in Claude**, and links that add the MCP server to Cursor or VS Code. `mcp: { name, guide }` sets the server name and a page that explains how to connect other tools. `mcp: false` turns the server off.

### Content only for agents

```md [content/docs/guide/ci.md]
::agent-only
Run `lumen check ./public --max-size 300kb` after the build. Exit code 1 means an image is too large.
::
```

The site renders nothing for `::agent-only`, and search skips it. The Markdown copy, llms-full.txt, and the MCP server keep it. Use it for CLI equivalents of UI steps and for mistakes that agents make, not for content that people need too.

### Rewrite the agent copy

When a page uses a component that has no Markdown form, `rawMarkdown` rewrites the page before the module writes its copy. It gets the Markdown and the page, and runs at build time, before the built-in rewrites. This one turns a `::demo-video{src="..."}` block into a link:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vite-hub/docs/nuxt'],
  docs: {
    rawMarkdown: markdown => markdown.replace(/::demo-video\{src="([^"]+)"\}\n::/g, '[Watch the demo]($1)'),
  },
})
```

## Search

`⌘K` opens the search dialog. It finds text under each `h2` and `h3` heading of every page. The index loads the first time the dialog opens, from `/api/_docs/search.json`. Agent-only content is not in it.

## Comments

A docs site on `vite-hub/nuxt` has [Comments](/docs/comments) on every page. Your team pins comments on a page, replies, mentions each other, and resolves threads. Install the package next to the modules:

```sh [commands/comments]
pnpm add @vite-hub/comments
```

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: [
    ['vite-hub/nuxt', { preset: 'node', console: { auth: false } }],
    '@vite-hub/docs/nuxt',
  ],
})
```

The docs module turns on the `comments` option of `vite-hub/nuxt`, which turns on the Database. The Console turns Comments on too. Apply the tables once with `vitehub db generate` and `vitehub db migrate`. You need no `server/comments.ts`. Add one to set `authorize`, `people`, or `onMention`. See [Configure Comments](/docs/comments/configure).

- **Each page has its own threads.** A thread belongs to the page path, such as `/docs/kv`. A new deploy keeps the threads on their page. A renamed page starts with none.
- **Readers see nothing.** The page loads the overlay only with `?vitehub` or the `vitehub-tools` cookie, and only for people that `authorize` lets read. Without `authorize`, a production build lets in the people that the Console admits to Comments, and people signed in with GitHub who can push to the repository. A reader who is not signed in gets no toolbar. When the app has no Console and no Auth, and GitHub sign-in is set up, `?vitehub` shows **Sign in with GitHub**. The development server lets everyone comment.
- **`@` lists your people.** With [Auth](/docs/auth), it suggests the users of Auth that may read the thread. Without Auth, it suggests the people who wrote in threads that you can read.
- **The Console lists the threads.** Open `/_vitehub` and select **Comments** to see every thread with its page, and open one.

Turn Comments off with `comments: false`. It sets `comments: false` on `vite-hub/nuxt`, so the Console does not turn Comments on either. Pass the `comments` options of `vite-hub/nuxt` to change the Database or to leave the overlay out of the pages:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  docs: {
    // Or `comments: false`.
    comments: { database: 'docs', overlay: false },
  },
})
```

A site without `vite-hub/nuxt` has no server for the threads, so it has no Comments. Setting `comments` to `true` or to an object there stops the build with [`DocsCommentsSetupError`](/docs/docs-site/limits-and-errors#docscommentssetuperror).

## Edit in the Console

The ViteHub Console edits, previews, and publishes docs pages through the [CMS](/docs/cms). The site keeps rendering the Markdown files. The CMS stores drafts and publishes them, and the Console preview shows a draft through the docs UI.

Install `vite-hub/nuxt` next to `@vite-hub/docs/nuxt`, and add one file:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import cms from 'vite-hub/cms'
import { docsCollection } from '@vite-hub/docs'

export const content = defineContent({
  extends: [cms, { repo: 'owner/name', publish: 'pr', access: 'roles' }],
  collections: { docs: docsCollection() },
})
```

Open `/_vitehub/content` and select **Docs**. The build reads this file without running it, so keep `defineContent({ extends, collections })` as written and give the `cms` options as string literals. Leave out the Content `seo` option: the docs module already serves the sitemap and the Markdown copy of each page, and Content's `.md` copies would compete with them in another format.

`docsCollection()` is a `documents()` collection over the pages:

- `path` is `content/**/*.md` by default. The folder before the first `*` must be the content folder, because the document id is the page file without `.md`. In a monorepo, pass `docsCollection({ path: 'docs/content/**/*.md' })`.
- `fields` are the page frontmatter. The Console validates them like the build does, and writes dotted keys such as `navigation.order` back as dotted keys.
- Each document URL is its page URL: `content/docs/kv/index.md` is `/docs/kv`, and `content/about.md` is `/about`.

With `repo`, the CMS uses the GitHub store and needs `VITEHUB_GITHUB_TOKEN`. A save commits to the `vitehub/content` branch, and `publish: 'pr'` opens a pull request into `main`. The site shows the change after the pull request merges and the site builds again. Without `repo`, the CMS uses the Blob + Database store. Its Workspace starts empty, and a publish does not change the files that the site renders, so use it only to try the editor. Run `vitehub db generate` and `vitehub db migrate` once, then import a page with `vitehub content edit docs docs/kv/index --file content/docs/kv/index.md`.

`access: 'roles'` uses the CMS roles of the Better Auth `admin` plugin. Your own `authorize` replaces it, for example `authorize: () => import.meta.dev` lets everyone edit on a development server and nobody in production.

The preview pane opens the page URL with the draft. The page route reads the draft from the collection and parses it like a published page, with `Cache-Control: private, no-store`. A page that exists only as a draft previews too. The sidebar, search, and previous and next links stay published. The preview needs a server that renders the page: a prerendered page on a static host shows the published file. Without `server/content.ts`, the page route reads only the files and bundles nothing from Content.
