---
title: Markdown templates
description: Render deterministic Markdown from explicit data, bounded conditions, fragments, and caller-resolved imports.
navigation.order: 52
icon: i-vscode-icons-file-type-markdown
---

`@vite-hub/markdown-template` composes Markdown without evaluating JavaScript or reading files implicitly. Use it when Agent Instructions, review prompts, or other generated documents need predictable data binding and conditional sections while preserving authored Markdown structure.

## Install

The package requires Node.js 24 or later.

```bash [Terminal]
pnpm add @vite-hub/markdown-template
```

## Use named template files

Place shared templates under `server/templates` and render them by their relative name. ViteHub discovers ordinary `.md` files in this directory, generates the valid template names for TypeScript, and bundles their contents before deployment.

```md [server/templates/review/pull-request.md]
# Review {{ pullRequest.number }}

Title: {{ pullRequest.title }}
```

```ts [server/agents/reviewer.ts]
import { renderTemplate, type TemplateName } from '#vitehub/templates'

export function renderPrompt(name: TemplateName, data: Record<string, unknown>) {
  return renderTemplate(name, data)
}

const prompt = await renderPrompt('review/pull-request', {
  pullRequest: { number: 611, title: 'Refine navigation' },
})
```

ViteHub removes the `server/templates/` prefix and `.md` extension from each catalog name. The path `server/templates/pull-request.md` becomes `pull-request`, while `server/templates/review/pull-request.md` becomes `review/pull-request`.

### Named template API

`renderTemplate(name, data?)` returns a `Promise<string>` after rendering the named template with the supplied data.

| Parameter | Type | Default | Purpose |
| --- | --- | --- | --- |
| `name` | `TemplateName` | Required | Selects a template from the generated literal union. TypeScript completes valid names and reports misspelled names. |
| `data` | `Record<string, unknown>` | `{}` | Supplies values for bindings, fragments, and conditions. |

JavaScript callers can bypass the generated union. At runtime, `renderTemplate` throws a `TypeError` when `name` does not exist in the bundled catalog.

The `vitehub()` preset installs template discovery. Modular Vite configurations can add `hubMarkdownTemplate()` from `@vite-hub/markdown-template/vite`. Both integrations resolve `server/templates` and generated files from the ViteHub project root, including projects that use a nested Vite root, and generate the ambient module under `.vitehub/types`, which the application `tsconfig.json` must include.

Use a `.template.md` suffix when a private template belongs beside its caller instead of in the shared catalog:

```ts [server/agents/reviewer.ts]
import prompt from './reviewer.template.md'

const markdown = await prompt({ pullRequest, sections })
```

Relative template imports work with both forms. Imported fragments can remain ordinary `.md` files.

Files ending in `.template.md` remain direct-import modules and do not enter the named catalog, even when they are under `server/templates`. The legacy `?markdown-template` import query remains supported for existing applications, but new code should use the `.template.md` suffix.

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
| `{{ path.to.value }}` | Scalar binding | Accepts a string, number, or boolean and escapes Markdown syntax in the value. Missing paths and non-scalar values fail rendering. |
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
