---
title: Build your first docs site
description: Create a Nuxt app with @vite-hub/docs, write one section of Markdown pages, and read it as a person and as a coding agent.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You build the docs site of Lumen, a made-up command-line tool. The site has a home page and one section with two pages. At the end, you read a page in the browser. Then you read the same page as plain Markdown with `curl`, as a coding agent does.

You need:

- Node.js 22.22 or newer
- pnpm
- an empty folder

You do not need an existing app or an account.

::tutorial-step{title="Create the app"}
## Create the app

Create a `package.json` file with this content. `"type": "module"` tells Node.js that your files use `import` and `export`. `dev` starts the site on your computer, and `build` makes the files to deploy.

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

Install the packages. `nuxt` runs the site. `@nuxt/ui` and `tailwindcss` give the components and the styles. `@vite-hub/docs` turns your Markdown files into docs pages.

```bash [commands/install]
pnpm add @vite-hub/docs nuxt @nuxt/ui tailwindcss
```

::

::tutorial-step{title="Add the module"}
## Add the module

Create `nuxt.config.ts`. It adds the docs module to Nuxt and gives the site a name:

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

`url` is the address of the live site. The site uses it to write full links: in `llms.txt` (a list of all pages for coding agents), in the canonical link of each page, and in the Markdown copies. The module adds Nuxt UI and the modules for coding agents itself, so `modules` has one entry.

::

::tutorial-step{title="Write a section"}
## Write a section

The module reads Markdown files from `content/`. Each folder in `content/docs/` is a section, a group of pages in the sidebar. Create the `guide` section, with its name and icon:

```yaml [content/docs/guide/.navigation.yml]
title: Guide
icon: i-lucide-book-open
```

`index.md` is the first page of the section, at `/docs/guide`. `navigation.title` is its label in the sidebar:

```md [content/docs/guide/index.md]
---
title: Guide
description: Install Lumen and compress your first folder of images.
navigation.title: Overview
---

Lumen needs Node.js 22.22 or newer. Read [Install Lumen](/docs/guide/install) first.
```

Add a page. `navigation.order` puts it first after the Overview. The `::agent-only` block is for coding agents. The site does not show it to people.

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

A file outside `content/docs/` is a plain page with no sidebar. `content/index.md` is the home page:

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

This proves that the module made a page and a sidebar from your files.

Keep the server running. In a second terminal, read the page as a coding agent does:

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

The Markdown copy has the title as a heading and keeps the agent-only text. So a coding agent gets the same page, plus the text that you wrote only for it. `curl http://localhost:3000/llms.txt` lists both pages with their descriptions.

Change the `title` of `install.md` and save. The server restarts, and the sidebar shows the new title. A change to the body shows only when you reload the page.

::

## Next steps

- [Configure](/docs/docs-site/configure): change the layout of a page, turn off the sidebar or the outline, and replace a component.
- [Assistant](/docs/docs-site/assistant): add a chat assistant that answers questions from your docs.
