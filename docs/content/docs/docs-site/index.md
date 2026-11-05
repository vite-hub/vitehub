---
title: Docs site
layout: landing
navigation.title: Overview
description: Turn a folder of Markdown files into a documentation site with navigation, search, tutorials, agent resources, and a docs assistant.
navigation.order: 1
icon: i-lucide-library
---

::product-hero{tagline="Write Markdown files. Get a documentation site that people and coding agents can read." hosts="Node, Cloudflare"}
  :::product-files
  ```ts [nuxt.config.ts]
  export default defineNuxtConfig({
    modules: ['@vite-hub/docs/nuxt'],
    docs: {
      // Name in titles, the rail, and llms.txt
      site: { name: 'Lumen', url: 'https://lumen.example.com' },
    },
  })
  ```

  ````md [content/docs/guide/install.md]
  ---
  title: Install Lumen
  description: Install the lumen binary with pnpm.
  ---

  Install the binary globally:

  ```sh
  pnpm add -g lumen-cli
  ```
  ````

  ```yaml [content/docs/guide/.navigation.yml]
  title: Guide
  icon: i-lucide-book-open
  ```
  :::
::

`@vite-hub/docs` is a Nuxt module. Each folder in `content/docs/` is a section, and each Markdown file in it is a page. The module gives the pages a shell, search, and a Markdown copy for coding agents. [vitehub.dev](https://vitehub.dev) runs on it.

::product-features
  :::product-feature-item{title="Markdown in, site out" icon="i-lucide-file-text" to="/docs/docs-site/get-started"}
  Folders are sections and files are pages. Frontmatter sets the title, the layout, and the order.
  :::

  :::product-feature-item{title="Three layouts" icon="i-lucide-layout-template" to="/docs/docs-site/configure#layouts"}
  `article` for guides, `tutorial` for numbered steps with a code panel, and `landing` for Overviews.
  :::

  :::product-feature-item{title="Navigation and outline per page" icon="i-lucide-sliders-horizontal" to="/docs/docs-site/configure#navigation-and-outline"}
  The left navigation and the right outline show by default. One frontmatter field turns each off.
  :::

  :::product-feature-item{title="Replace any part" icon="i-lucide-code-2" to="/docs/docs-site/configure#replace-a-component"}
  Create a component with the same name, such as `DocsPageHeaderLinks`, and the shell uses yours.
  :::

  :::product-feature-item{title="Pages for coding agents" icon="i-lucide-bot" to="/docs/docs-site/configure#agent-resources"}
  Each page has a Markdown copy at `/raw`. llms.txt, a sitemap, and an MCP server come with no setup.
  :::

  :::product-feature-item{title="Edit pages in the Console" icon="i-lucide-pencil" to="/docs/docs-site/configure#edit-in-the-console"}
  The CMS edits, previews, and publishes pages, with a pull request per publish.
  :::

  :::product-feature-item{title="Comments on every page" icon="i-lucide-message-circle" to="/docs/docs-site/configure#comments"}
  With `vite-hub/nuxt`, your team pins comments on a page and replies. `comments: false` turns them off.
  :::

  :::product-feature-item{title="A docs assistant on your ChatGPT plan" icon="i-lucide-message-square-text" to="/docs/docs-site/assistant"}
  A ViteHub Agent answers reader questions from your pages and links them. No API key.
  :::
::

## Defaults first

The theme is black, white, and zinc, with square corners and hairline borders. Every option has a default, so a site name is enough to start. When a default does not fit, change one option in `nuxt.config.ts`, one field in the page frontmatter, or one component. See [Configure](/docs/docs-site/configure).

## Reference and limits

The [Server API](/docs/docs-site/server-api) lists every module option, frontmatter field, export, and route. [Limits and errors](/docs/docs-site/limits-and-errors) lists what the module does not do yet, and the fix for each error.
