# `@vite-hub/markdown-template`

`@vite-hub/markdown-template` renders deterministic Markdown from explicit data. It combines scalar values, Markdown fragments, bounded conditional sections, and caller-resolved relative imports without evaluating JavaScript or performing implicit I/O.

```ts
import { renderMarkdownTemplate } from "@vite-hub/markdown-template"

const markdown = await renderMarkdownTemplate(template, {
  data: {
    pullRequest,
    sections: {
      files: filesMarkdown,
    },
  },
})
```

Use `{{ pullRequest.title }}` for a string, number, or boolean. Scalar values are serialized as Markdown text, so Markdown syntax in the value stays literal. Use `{{{ sections.files }}}` for an intentional Markdown fragment. Fragments are never evaluated again, so bindings, branches, and imports inside their content stay literal.

Scalar bindings also work inside quoted XML-style attributes. Attribute values are HTML-escaped, while template syntax inside code spans and code blocks stays literal.

Conditional sections support own-property data paths, literals, `!`, equality and inequality (`===`, `!==`, `==`, and `!=` use strict semantics), `&&`, `||`, and parentheses:

```md
::if{pullRequest.available && !pullRequest.draft}
Review {{ pullRequest.title }}.
::else
No review context is available.
::
```

Imports only run when you provide `resolveImport`. The resolver receives a relative specifier and the current canonical source ID, and it returns the imported template with its canonical ID for cycle detection:

```ts
await renderMarkdownTemplate(template, {
  sourceId: "/templates/review.md",
  resolveImport: async (specifier, importer) => {
    return { id: resolvedId, template: importedMarkdown }
  },
})
```

Imports resolve before conditional sections are evaluated, so the resolver must authorize every requested import even when it appears inside an unselected branch.

The package does not provide loops, helpers, macros, a compile phase, filesystem or URL access, HTML rendering, or public syntax-tree hooks. Markdown fragments preserve document structure, but they do not make untrusted content safe for a model; instruction and data boundaries remain the caller's responsibility.

Comark provides the Markdown parser, component syntax, syntax tree, and serializer. ViteHub owns the constrained composition policy exposed by this package.

## Vite template modules

The Vite integration can bundle a caller-relative Markdown file as a render function, so the source file does not need to exist in the deployed runtime:

```ts
import prompt from "./prompt.md?markdown-template"

const markdown = await prompt({ pullRequest, sections })
```

The `vitehub()` preset installs the integration. Modular Vite configs can add `hubMarkdownTemplate()` from `@vite-hub/markdown-template/vite`; both forms generate the ambient import type under `.vitehub/types`. Include `.vitehub/types/**/*.d.ts` in the application's `tsconfig.json` so TypeScript sees the generated module type.
