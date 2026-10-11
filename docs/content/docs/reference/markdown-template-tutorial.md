---
title: Render your first Markdown template
description: "Install the Markdown Template package, bind data, and return rendered Markdown."
layout: tutorial
navigation.title: Tutorial
navigation.order: 52
navigation.group: Tutorial
icon: i-lucide-rocket
---

Generate a short release note from a Markdown template and a data object. You will insert the version and status as text, then include a trusted Markdown list. The result is a Markdown string that you can print or pass to an Agent.

You need Node.js 24.15 or newer and pnpm. Run this example in an existing ESM project, or run `pnpm init` and `pnpm pkg set type=module` in an empty directory first. The renderer needs no Vite server, account, or network access.

::tutorial-step{title="Install the package"}
## Install the package

```bash [commands/install]
pnpm add @vite-hub/markdown-template
```

The package accepts a complete template string and an explicit `data` object.
Scalar bindings are escaped Markdown text. Use `:insert` only for a fragment
that your application has already validated.
::

::tutorial-step{title="Render a document"}
## Render a document

Create this file and its parent directory. Double braces insert scalar values as escaped text. `:insert` preserves the Markdown list, so only pass a fragment that your application trusts.

```ts [server/render-release.ts]
import { renderMarkdownTemplate } from "@vite-hub/markdown-template";

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

The template escapes scalar values while preserving the list supplied through
the trusted `notes` fragment.
::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Run the module with Node 24:

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

For a file-backed template, import a `*.template.md` file directly. The
`vitehub()` preset handles the module in a framework application, or a modular
Vite config can add `hubMarkdownTemplate()` from
`@vite-hub/markdown-template/vite`. Read [Markdown templates](/docs/reference/markdown-templates)
for conditions, file imports, and migration rules. [Agent Instructions](/docs/agents/instructions)
shows how to use rendered Markdown as durable Agent guidance.
::
