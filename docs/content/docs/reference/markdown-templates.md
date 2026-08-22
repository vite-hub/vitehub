---
title: Markdown templates
description: Render deterministic Markdown from explicit data, bounded conditions, fragments, and caller-resolved imports.
navigation.order: 53
icon: i-vscode-icons-file-type-markdown
---

`@vite-hub/markdown-template` composes Markdown without evaluating JavaScript or reading files implicitly. Use it when Agent Instructions, review prompts, or other generated documents need predictable data binding and conditional sections while preserving authored Markdown structure.

## Install

The package requires Node.js 24 or later.

```bash [Terminal]
pnpm add @vite-hub/markdown-template
```

## Import a template file

Place a `*.template.md` file beside the module that renders it. Importing the file returns an asynchronous render function.

```md [server/agents/reviewer/prompt.template.md]
# Review {{ pullRequest.number }}

Title: {{ pullRequest.title }}
```

```ts [server/agents/reviewer/agent.ts]
import renderPrompt from './prompt.template.md'

const prompt = await renderPrompt({
  pullRequest: { number: 611, title: 'Refine navigation' },
})
```

ViteHub bundles the template and its relative Markdown imports before deployment. The deployed application does not read these source files at runtime. The generated module type accepts an optional `Record<string, unknown>` and returns `Promise<string>`.

When one caller owns several templates, you may group them in a local directory such as `./templates/`. The directory has no discovery behavior; import each `*.template.md` file directly. Multiple callers can also import the same template from an explicitly shared source path.

For a fixed runtime choice, define the allowed names with an ordinary TypeScript map:

```ts [server/agents/reviewer/replies.ts]
import renderFailure from './failure.template.md'
import renderSuccess from './success.template.md'

export const replies = {
  failure: renderFailure,
  success: renderSuccess,
} as const
```

The `vitehub()` preset installs the template module integration. Modular Vite configurations can add `hubMarkdownTemplate()` from `@vite-hub/markdown-template/vite`. Both forms generate the ambient module type under `.vitehub/types`, which the application `tsconfig.json` must include.

Imported fragments can remain ordinary `.md` files.

`repositoryHostContext({ materialize })` uses the same path convention. Pass a caller-relative `.template.md` path; ViteHub bundles its renderer and derives the generated `.md` path by removing only the final `.template`, preserving directories and case.

## Render a template string

Pass the template string and the complete data available to it. Scalar bindings are escaped as Markdown text, while triple bindings insert an intentional Markdown fragment.

```ts [src/review-template.ts]
import { renderMarkdownTemplate } from '@vite-hub/markdown-template'

const markdown = await renderMarkdownTemplate([
  '# Review {{ pullRequest.number }}',
  '',
  'Title: {{ pullRequest.title }}',
  '',
  '::if{pullRequest.draft}',
  'This pull request is a draft.',
  '::else',
  '{{{ sections.files }}}',
  '::',
].join('\n'), {
  data: {
    pullRequest: {
      draft: false,
      number: 611,
      title: 'Refine navigation',
    },
    sections: {
      files: '## Files\n\n- `DocsAsideLeftBody.vue`',
    },
  },
})
```

The result keeps the fragment as document structure:

```md [Rendered Markdown]
# Review 611

Title: Refine navigation

## Files

- `DocsAsideLeftBody.vue`
```

## Template syntax

| Syntax | Purpose | Behavior |
| --- | --- | --- |
| `{{ path.to.value }}` | Scalar binding | Accepts a string, number, or boolean and escapes Markdown syntax in the value. A scalar may occupy a complete inline link destination, such as `[Open]({{ url }})`; unsafe destinations and values whose URL meaning cannot be preserved fail rendering. Missing paths and non-scalar values fail rendering. |
| `{{{ path.to.markdown }}}` | Markdown fragment | Inserts trusted Markdown without evaluating bindings, conditions, or imports inside the fragment again. Block Markdown is rejected when the binding appears in an inline position. |
| `::if{condition}` | Conditional section | Selects an `if`, `else-if`, or `else` branch. Conditions support data paths, literals, `!`, equality and inequality (`===`, `!==`, `==`, and `!=` use strict semantics), `&&`, <code>&#124;&#124;</code>, and parentheses. |
| `@./relative.md` | Template import | Calls `resolveImport` for a relative file. Absolute paths, URLs, and globs are rejected. |
| `{{ value }}` in a quoted XML-style attribute | Attribute binding | Escapes HTML attribute characters before inserting the scalar value. |

Template syntax inside code spans, fenced code blocks, and indented code blocks remains literal. Authored XML-style tags remain in the rendered Markdown.

## Render options

`renderMarkdownTemplate(template, options)` returns a `Promise<string>` and accepts every `RenderMarkdownTemplateOptions` field below.

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `data` | `Record<string, unknown>` | `{}` | Supplies values for scalar bindings, fragments, and conditions. Paths resolve own properties only. |
| `maxImportDepth` | `number` | `4` | Limits nested imports when `resolveImport` is present. Use a non-negative integer; `0` rejects every import. |
| `resolveImport` | `ResolveMarkdownTemplateImport` | none | Resolves one relative specifier against the current canonical source id. Without it, relative-looking text remains literal. |
| `sourceId` | `string` | `<template>` | Identifies the root template for relative resolution and circular-import detection. |

The import resolver returns `{ id, template }`, where `id` is the canonical identity used for nested imports and cycle detection.

```ts [src/render-instructions.ts]
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { renderMarkdownTemplate } from '@vite-hub/markdown-template'

const sourceId = resolve('instructions/review.md')
const template = await readFile(sourceId, 'utf8')

const markdown = await renderMarkdownTemplate(template, {
  data: { repository: { name: 'vite-hub/vitehub' } },
  sourceId,
  async resolveImport(specifier, importer) {
    const id = resolve(dirname(importer), specifier)
    return { id, template: await readFile(id, 'utf8') }
  },
})
```

The resolver owns filesystem, URL, authorization, and caching policy. ViteHub resolves imports before evaluating conditional sections, rejects missing resolutions, and stops circular imports, so the resolver must authorize every requested import even when it appears inside an unselected branch.

## Security and limits

Scalar escaping prevents untrusted values from becoming Markdown syntax, but rendered Markdown is still data for the next consumer. Triple-bound fragments are trusted input and do not create an instruction or security boundary for a model.

The package deliberately has no loops, helpers, macros, compile phase, HTML renderer, implicit filesystem access, or public syntax-tree API. Prepare repeated sections in application code, pass the finished Markdown as a fragment, and keep import access inside `resolveImport`.

## Related pages

- [Agent Instructions](/docs/agents/instructions)
- [Package reference](/docs/reference)
- [Import paths](/docs/reference/import-paths)
