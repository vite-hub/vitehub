---
title: Build your first docs site
description: Create a Nuxt app with @vite-hub/docs, write one section of Markdown pages, and read it as a person and as a coding agent.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

`@vite-hub/docs` turns a folder of Markdown files into a documentation site. People read it in the browser. Coding agents read the same pages as plain Markdown.

In this tutorial, you build the docs site of Lumen, a made-up command-line tool. The site has a home page and one section with two pages. At the end, you read a page in the browser, and you read its Markdown copy with `curl`.

> [!NOTE] Before you start
> You need Node.js 22.22 or newer and pnpm. You need no account and no API key. You start from an empty folder.

::tutorial-step{title="Create the app"}
## Create the app

Create a folder for the site. Add a `package.json` with the two scripts that Nuxt uses:

```json [package.json]
{
  "name": "lumen-docs",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "nuxt dev",
    "build": "nuxt build"
  }
}
```

Install Nuxt 5, Nuxt UI, Tailwind CSS, Comark with its Vue and HTML renderers and comark-ui, and the docs module. Nuxt 5 is only in nightly builds for now:

```bash pm [commands/install]
pnpm add @vite-hub/docs nuxt@npm:nuxt-nightly@5x @nuxt/ui tailwindcss comark @comark/vue @comark/html comark-ui
```

::

::tutorial-step{title="Turn on the module"}
## Turn on the module

Add the module to `nuxt.config.ts`, and give the site a name:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vite-hub/docs/nuxt'],
  docs: {
    site: {
      name: 'Lumen',
      url: 'https://lumen.example.com',
      description: 'Resize and compress images from the command line.',
    },
  },
  compatibilityDate: '2026-11-01',
})
```

- `name` shows in the page titles and in llms.txt.
- `url` is the public address of the site. The links in llms.txt and in the Markdown copies start with it. llms.txt is the list of pages for coding agents.
- `modules` has only one entry. The docs module adds Nuxt UI and the other modules that it needs.

::

::tutorial-step{title="Write a section"}
## Write a section

The module reads Markdown from the `content/` folder. Each folder in `content/docs/` is a section. Create the `guide` section, with its name and icon:

```yaml [content/docs/guide/.navigation.yml]
title: Guide
icon: i-lucide-book-open
```

Add `index.md`. It is the first page of the section, at `/docs/guide`. In the sidebar, the section name, Guide, links to it. `navigation.title` is its label in page lists, such as the links at the end of each Markdown copy:

```md [content/docs/guide/index.md]
---
title: Guide
description: Install Lumen and compress your first folder of images.
navigation.title: Overview
---

Lumen needs Node.js 22.22 or newer. Read [Install Lumen](/docs/guide/install) first.
```

Add a second page:

````md [content/docs/guide/install.md]
---
title: Install Lumen
description: Install the lumen binary with pnpm.
navigation.order: 1
---

Install the binary globally:

```sh
pnpm add -g lumen-cli
```

::agent-only
Run `lumen --version` to check the install. It prints a version such as `1.4.0`.
::

## Check the version

```sh
lumen --version
```
````

- `navigation.order: 1` puts the page first after the section page.
- `::agent-only` holds text for coding agents. The site does not show it to people.
- The page heading comes from `title`. Do not start the body with `# Install Lumen`.

::

::tutorial-step{title="Add the home page"}
## Add the home page

A file outside `content/docs/` is a plain page with only the site header. Create `content/index.md`. It is the home page:

```md [content/index.md]
---
title: Lumen
description: Resize and compress images from the command line.
---

Lumen resizes and compresses images. Start with [Install Lumen](/docs/guide/install).
```

::

::tutorial-step{title="Read the site"}
## Read the site

Start the development server:

```bash [commands/start]
pnpm dev
```

Open `http://localhost:3000/docs/guide/install`. You see:

- The sidebar on the left, with the Guide section and Install Lumen. Select Guide to open the section page.
- On a wide screen, the outline on the right, with Check the version.
- No agent-only text.

Press `⌘K`, or `Ctrl+K` on Windows and Linux, to search.

Keep the server running. Open a second terminal and read the page as a coding agent does:

```bash [commands/agent-copy]
curl http://localhost:3000/raw/docs/guide/install.md
```

````md [output/install.md]
# Install Lumen

Install the binary globally:

```sh
pnpm add -g lumen-cli
```

Run `lumen --version` to check the install. It prints a version such as `1.4.0`.

## Check the version

```sh
lumen --version
```

<!-- vitehub-docs:section-links -->
## In this section

- [Overview](https://lumen.example.com/raw/docs/guide.md)
- [Install Lumen](https://lumen.example.com/raw/docs/guide/install.md) (this page)

All pages: [llms.txt](https://lumen.example.com/llms.txt)
````

The copy starts with the title as a heading, and it has the agent-only text. At the end, it links the other pages of the section. The links start with `url`. Run `curl http://localhost:3000/llms.txt` to see both pages with their descriptions.

Change the `title` of `install.md` and save. The server restarts, and the sidebar shows the new title. A change to the body shows only when you reload the page.

::

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/docs-site/configure"}
Change the layout of a page, turn off the navigation or the outline, and replace a component.
:::

:::card{title="Docs assistant" icon="i-lucide-bot" to="/docs/docs-site/assistant"}
Answer reader questions from your pages with an Agent.
:::
::
