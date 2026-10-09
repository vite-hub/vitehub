---
title: ViteHub documentation
description: Server Primitives and Agents for Vite applications, one product section each, deployed on the host you select.
navigation: false
icon: i-lucide-book-open
---

ViteHub adds server features to Vite applications. Each **Server Primitive** is
one product with one import, one configuration, and one docs section. Trusted
application code calls it directly. An **Agent** can receive selected
operations from a primitive through its Agent capability page.

```bash [Terminal]
pnpm add vite-hub
```

Register `vitehub()` in `vite.config.ts`, select the primitives the application
uses, then call the documented import from server code. The
[installation guide](/docs/getting-started/installation) covers Vite, Nuxt, and
the owner packages.

Every product section uses the same task lanes when they apply, then labels
each page by the job it helps you do. Start with the Tutorial for a first
working result. Use Guides for focused tasks, Reference for exact imports and
options, Deploy for host choices, and Operate for limits and failure behavior.
Open a package below, or press the search key to jump to any page.

::docs-catalog
::
