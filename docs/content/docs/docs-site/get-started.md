---
title: Build your first docs site
description: Create a Nuxt app with @vite-hub/docs, write one section of Markdown pages, and read it as a person and as a coding agent.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Build the docs site of Lumen, a made-up command-line tool. The site has a home page and one section with two pages. At the end, you read a page in the browser and its Markdown copy with `curl`.

You need Node.js 24.15 or newer and pnpm. No account is necessary.

::tutorial-step{title="Create the app"}
## Create the app

Create a folder for the site, and add a `package.json` with the two scripts that Nuxt uses:

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

Install Nuxt, Nuxt UI, Tailwind CSS, and the docs module:

```bash [commands/install]
pnpm add @vite-hub/docs nuxt @nuxt/ui tailwindcss
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

`url` is the public origin of the site. llms.txt, canonical links, and the links in the Markdown copies use it. The module installs Nuxt UI and the agent modules itself, so `modules` has one entry.

::

::tutorial-step{title="Write a section"}
## Write a section

The module reads Markdown from `content/`. Each folder in `content/docs/` is a section. Create the `guide` section, with its name and icon:

```yaml [content/docs/guide/.navigation.yml]
title: Guide
icon: i-lucide-book-open
```

`index.md` is the Overview of the section, at `/docs/guide`. `navigation.title` is its label in the sidebar:

```md [content/docs/guide/index.md]
---
title: Guide
description: Install Lumen and compress your first folder of images.
navigation.title: Overview
---

Lumen needs Node.js 24 or newer. Read [Install Lumen](/docs/guide/install) first.
```

Add a page. `navigation.order` puts it first after the Overview. The `::agent-only` block is for coding agents: the site does not show it.

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

The page heading comes from `title`, so the body does not start with `# Install Lumen`.

::

::tutorial-step{title="Add the home page"}
## Add the home page

A file outside `content/docs/` is a plain page under the site header. `content/index.md` is the home page:

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

Open `http://localhost:3000/docs/guide/install`. The sidebar on the left lists the Guide section with Overview and Install Lumen. On a wide screen, the outline on the right lists Check the version. The agent-only text is not on the page. Press `⌘K` to search.

Keep the server running. In another terminal, read the page as a coding agent does:

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
````

The copy has the title as a heading and keeps the agent-only text. `curl http://localhost:3000/llms.txt` lists both pages with their descriptions.

Change the `title` of `install.md` and save. The server restarts, and the sidebar shows the new title. A change to the body only shows when you reload the page.

::

Next, [change the layout of a page, turn off the navigation or the outline, and replace a component](/docs/docs-site/configure), or [add the docs assistant](/docs/docs-site/assistant).
