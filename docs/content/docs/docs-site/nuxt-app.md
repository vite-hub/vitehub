---
title: Add docs to a Nuxt app
description: Add a /docs section to the Nuxt app that you have. The app keeps its pages, its app.vue, its layouts, and its Nuxt UI theme.
layout: tutorial
codePanel: true
navigation.title: Add to a Nuxt app
navigation.order: 3
icon: i-lucide-square-plus
---

Add docs to Acme, a Nuxt app that has a home page and a pricing page. At the end, `/docs` is a docs site with navigation, search, and Markdown copies for coding agents. `/` and `/pricing` are the same as before.

You need a Nuxt 5 app with Nuxt UI 4.11 or newer and Tailwind CSS. For a site that is only docs, start with [Build your first docs site](/docs/docs-site/get-started).

::tutorial-step{title="Install the module"}
## Install the module

```bash [commands/install]
pnpm add @vite-hub/docs
```

Add it after Nuxt UI, and give the docs a name:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@vite-hub/docs/nuxt'],
  css: ['~/assets/main.css'],
  docs: {
    site: { name: 'Acme', url: 'https://acme.dev' },
  },
})
```

`url` is the public origin. llms.txt, canonical links, and the Markdown copies use it.

::

::tutorial-step{title="Check app.vue"}
## Check `app.vue`

The app keeps its own `app.vue`. The docs pages render through Nuxt layouts and use Nuxt UI overlays, so `app.vue` wraps `<NuxtPage />` in `<UApp>` and `<NuxtLayout>`:

```vue [app/app.vue]
<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
```

When one of the two is missing, the development server prints a warning that names it.

::

::tutorial-step{title="Write the docs"}
## Write the docs

Put the pages in `content/docs/`. A page's URL is its path in the folder, so `content/docs/guide/install.md` is `/docs/guide/install`. Each folder is a section.

```md [content/docs/index.md]
---
title: Acme docs
description: Set up Acme and ship your first project.
---

Start with the [guide](/docs/guide).
```

```md [content/docs/guide/index.md]
---
title: Guide
description: Install Acme.
navigation.title: Overview
---

Read [Install](/docs/guide/install) first.
```

````md [content/docs/guide/install.md]
---
title: Install
description: Install the acme package.
---

```sh
pnpm add acme
```
````

::

::tutorial-step{title="Read the docs"}
## Read the docs

```bash [commands/dev]
pnpm dev
```

Open `http://localhost:3000/docs/guide/install`. The page has the docs sidebar, the outline, and search on `⌘K`. Open `http://localhost:3000/`: the home page of the app has its own layout and its own colors.

Read the page as a coding agent:

```bash [commands/agent-copy]
curl http://localhost:3000/raw/docs/guide/install.md
```

::

::tutorial-step{title="Build"}
## Build

```bash [commands/build]
pnpm build
```

The build prerenders each docs page and its page data. It does not crawl the links on these pages, so `/` and `/pricing` stay server-rendered as before.

::

## What the module changes in your app

The module adds the docs and leaves the rest of the app as it is:

| Part | Docs pages | The app's own pages |
| --- | --- | --- |
| Routes | A catch-all page at `/docs/**`. | Unchanged. A static page, such as `pages/docs/faq.vue`, wins over the docs page. `pages/[...slug].vue` keeps every path outside `/docs`. |
| `app.vue`, layouts, error page | The `docs` and `docs-article` layouts draw the docs header, sidebar, and search. | Unchanged. A missing docs page shows the app's error page. |
| Design | The docs design. Its CSS applies below the `vh-docs` class, which the docs layouts set on `<html>`. Nuxt UI's `<UTheme>` gives the docs components their classes. | Unchanged. `app.config.ts` stays as written. The docs pages use the app's Nuxt UI colors. |
| Head | Title template, canonical link, and share tags. | Unchanged. |
| Prerender | Every docs page. | Not crawled. |

It also adds these routes at the root of the app: `/raw/**` for the Markdown copies, `/llms.txt`, `/llms-full.txt`, `/sitemap.md`, `/sitemap.xml`, `/mcp`, and `/api/_docs/**`. `docs: { mcp: false }` removes `/mcp`. See [Agent resources](/docs/docs-site/configure#agent-resources).

To serve the docs at another prefix, rename the folder and set `base`: `content/help/` with `docs: { base: '/help' }` is at `/help`. To make the docs the whole site, leave out `content/docs/` and write the sections in `content/`. See [Organize the content](/docs/docs-site/configure#organize-the-content).
