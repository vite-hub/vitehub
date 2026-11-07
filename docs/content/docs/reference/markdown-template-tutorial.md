---
title: Render your first Markdown template
description: "Install the Markdown Template package, bind data, and return rendered Markdown."
layout: tutorial
navigation.title: Tutorial
navigation.order: 52
navigation.group: Application APIs
icon: i-lucide-rocket
---

You write a short release note from a Markdown template and some data. The template fills in the version and the status, then adds a list of notes. At the end, you print the Markdown text. You can show it or give it to an Agent.

You need:

- Node.js 22.18 or newer
- pnpm
- an empty folder

You do not need a Vite app, a cloud account, or network access.

::tutorial-step{title="Install the package"}
## Install the package

Create a `package.json` file with this content. `"type": "module"` tells Node.js that your files use `import` and `export`.

```json [package.json]
{
  "type": "module"
}
```

Then install Markdown Template:

```bash [commands/install]
pnpm add @vite-hub/markdown-template
```

::

::tutorial-step{title="Write the template"}
## Write the template

Create `server/render-release.ts`:

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

- `renderMarkdownTemplate()` takes the template text and a `data` object.
- `{{ data.version }}` puts a value in the text. The value is escaped, so a character such as `*` or `#` shows as text and does not become Markdown.
- `:insert{:markdown="data.notes"}` adds `notes` as Markdown, so the list stays a list. It does not escape anything. Use it only for Markdown that your app made or already checked.

::

::tutorial-step{title="Run it"}
## Run it

Run the file. Node.js 22.18 and newer run TypeScript files directly:

```sh [commands/verify]
node server/render-release.ts
```

You see:

```md [output/result.md]
# Release 0.0.4

Status: ready

- Build passes
- Preview checked
```

The version and the status are in the text, and the notes are a Markdown list. This proves that the template filled in the values and kept the inserted Markdown.

::

## Next steps

- [Markdown templates](/docs/reference/markdown-templates): keep a template in its own `*.template.md` file and import it, add conditions, and migrate old templates. In a Vite app, the `vitehub()` plugin handles these files. Without it, add `hubMarkdownTemplate()` from `@vite-hub/markdown-template/vite`.
- [Agent Instructions](/docs/agents/instructions): use the Markdown as instructions for an Agent.
