---
title: Render your first Markdown template
description: "Install the Markdown Template package, bind data, and return rendered Markdown."
layout: tutorial
navigation.title: Tutorial
navigation.order: 52
navigation.group: Application APIs
icon: i-lucide-rocket
---

Build a short release note from a Markdown template and a data object. You insert the version and status as text, then add a trusted Markdown list. You get a Markdown string to print or pass to an Agent.

You need Node.js 22.18 or newer and pnpm. Set `"type": "module"` in `package.json` so Node.js reads `import` and `export`. You need no Vite server, account, or network access.

::tutorial-step{title="Install the package"}
## Install the package

```bash [commands/install]
pnpm add @vite-hub/markdown-template
```

The renderer takes a full template string and a `data` object. It escapes scalar values as Markdown text.
::

::tutorial-step{title="Render a document"}
## Render a document

Create this file. Double braces insert scalar values as escaped text. `:insert` keeps the Markdown list as is, so pass it only a fragment that your app has checked and trusts.

```ts [server/render-release.ts]
import { renderMarkdownTemplate } from "vite-hub/markdown-template";

const markdown = await renderMarkdownTemplate(
  [
    "# Release {{ data.version }}",
    "",
    "Status: {{ data.status }}",
    "",
    ":insert{:markdown=\"data.notes\"}",
  ].join("\n"),
  {
    data: {
      version: "0.0.4",
      status: "ready",
      notes: "- Build passes\n- Preview checked",
    },
  },
);

console.log(markdown);
```

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Run the file with Node.js 22.18 or newer:

```sh [commands/verify]
node server/render-release.ts
```

The output is Markdown:

```md [output/result.md]
# Release 0.0.4

Status: ready

- Build passes
- Preview checked
```

To keep the template in a file, import a `*.template.md` file. In a framework app, `vitehub()` loads it. In a modular Vite config, add `hubMarkdownTemplate()` from `@vite-hub/markdown-template/vite`.

Next, read [Markdown templates](/docs/reference/markdown-templates) for conditions, file imports, and migration. [Agent Instructions](/docs/agents/instructions) shows how to use rendered Markdown as lasting Agent guidance.
::
