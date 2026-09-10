---
title: Markdown templates
description: Render deterministic Markdown from explicit data, bounded conditions, fragments, and caller-resolved imports.
navigation.order: 53
navigation.group: Application APIs
icon: i-vscode-icons-file-type-markdown
---

`@vite-hub/markdown-template` renders Markdown from explicit file paths or template strings without evaluating JavaScript. Use it when Agent Instructions, review prompts, or other generated documents need predictable data binding and conditional sections while preserving authored Markdown structure.

## Install

The package requires Node.js 24 or later.

```bash [Terminal]
pnpm add @vite-hub/markdown-template
```

## Render a Markdown file

Use an ordinary `.md` file and pass its path to `renderMarkdownFile()`.

```md [server/agents/reviewer/prompt.md]
# Review {{ pullRequest.number }}

Title: {{ pullRequest.title }}

@./policy.md
```

```md [server/agents/reviewer/policy.md]
Check correctness and regression coverage.
```

```ts [server/agents/reviewer/agent.ts]
import { renderMarkdownFile } from 'vite-hub/markdown-template'

const prompt = await renderMarkdownFile(
  new URL('./prompt.md', import.meta.url),
  { data: { pullRequest: { number: 611, title: 'Refine navigation' } } },
)
```

Libraries can import the same function from `@vite-hub/markdown-template`. No template plugin, special filename suffix, or generated module declaration is needed.

The function accepts a filesystem path string or a `file:` URL and returns `Promise<string>`. Relative path strings resolve against the process working directory. A URL constructed with `import.meta.url` resolves beside the executing module. HTTP URLs are not supported.

`RenderMarkdownFileOptions` accepts `data` and `maxImportDepth`, with the same defaults as the string renderer. Each call reads the root file and its relative fragments from the local filesystem. It resolves symlinks to canonical paths, resolves fragments beside their canonical importing file, and rejects cycles. Missing files reject the render with the filesystem error. Import examples inside code remain literal.

For a fixed runtime choice, use a map of file URLs:

```ts
const replies = {
  failure: new URL('./failure.md', import.meta.url),
  success: new URL('./success.md', import.meta.url),
} as const

const reply = await renderMarkdownFile(replies.success, {
  data: { repository: 'vite-hub/vitehub' },
})
```

### Deploy file templates

Ship the Markdown files and their fragment directories with the server application. ViteHub does not discover, bundle, or copy files passed to this function. After bundling, `import.meta.url` identifies the emitted module, so place the files relative to that module or pass a configured absolute path. Missing files fail when rendered, rather than during the build.

This API requires local filesystem access. For hosts without shipped local files, use `renderMarkdownTemplate()` with content supplied by a Workspace, Source, or application storage and an explicit import resolver.

Only pass trusted file paths and authored templates. Relative fragments can reach parent directories through `../` and symlinks; this function does not confine access to the root template directory. Imports are read before conditions run. Use the string renderer with a restricted resolver when the application must control each read.

### Migrate from callable template imports

This is a breaking replacement for `import renderPrompt from './prompt.template.md'`. Rename template files to `.md`, replace callable imports with `renderMarkdownFile(path, { data })`, and ship the file tree with the application. Remove `hubMarkdownTemplate()`, imports from `@vite-hub/markdown-template/vite`, and obsolete `.vitehub/types/markdown-template.d.ts` declarations. The template-specific `?markdown-template` query and Vite integration are removed. Existing string rendering and ordinary Vite raw assets keep their existing behavior.

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
| `@./relative.md` | Template import | The file renderer reads the relative file. The string renderer calls the supplied `resolveImport`. Absolute paths, URLs, and globs are rejected. |
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

For a custom storage or access policy, pass `sourceId` and `resolveImport` to `renderMarkdownTemplate()`. Use `renderMarkdownFile()` for ordinary local files.

The resolver owns filesystem, URL, authorization, and caching policy. ViteHub resolves imports before evaluating conditional sections, rejects missing resolutions, and stops circular imports, so the resolver must authorize every requested import even when it appears inside an unselected branch.

## Security and limits

Scalar escaping prevents untrusted values from becoming Markdown syntax, but rendered Markdown is still data for the next consumer. Triple-bound fragments are trusted input and do not create an instruction or security boundary for a model.

The package deliberately has no loops, helpers, macros, compile phase, HTML renderer, implicit filesystem access, or public syntax-tree API. Prepare repeated sections in application code, pass the finished Markdown as a fragment, and keep import access inside `resolveImport`.

## Related pages

- [Agent Instructions](/docs/agents/instructions)
- [Package reference](/docs/reference)
- [Import paths](/docs/reference/import-paths)
