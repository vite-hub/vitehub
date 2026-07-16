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

The renderer does not provide loops, helpers, macros, a compile phase, filesystem or URL access, HTML rendering, or public syntax-tree hooks. Markdown fragments preserve document structure, but they do not make untrusted content safe for a model; instruction and data boundaries remain the caller's responsibility.

Comark provides the Markdown parser, component syntax, syntax tree, and serializer. ViteHub owns the constrained composition policy exposed by this package.

## Named templates

Markdown files under `server/templates` are discovered by relative name and bundled before deployment:

```ts
import { renderTemplate, type TemplateName } from "#vitehub/templates"

const markdown = await renderTemplate("review/pull-request", { pullRequest, sections })

export function renderPrompt(name: TemplateName, data: Record<string, unknown>) {
  return renderTemplate(name, data)
}
```

ViteHub removes the `server/templates/` prefix and `.md` extension from each catalog name. For example, `server/templates/pull-request.md` becomes `pull-request`, while `server/templates/review/pull-request.md` becomes `review/pull-request`.

`renderTemplate(name, data?)` returns a `Promise<string>`. The generated `TemplateName` union autocompletes valid names and rejects typos, while the optional data record defaults to `{}`. A JavaScript caller that passes an unknown name receives a `TypeError` at runtime.

Use a `.template.md` file when a private prompt belongs beside its caller instead of in the application catalog:

```ts
import prompt from "./prompt.template.md"

const markdown = await prompt({ pullRequest, sections })
```

Relative Markdown imports work in both forms and can remain ordinary `.md` files.

Files ending in `.template.md` remain direct-import modules and do not enter the named catalog, even when they are under `server/templates`. The legacy `?markdown-template` import query remains supported for existing applications, but new code should use the `.template.md` suffix.

The `vitehub()` preset installs the integration. Modular Vite configs can add `hubMarkdownTemplate()` from `@vite-hub/markdown-template/vite`; both forms generate template names and ambient module types under `.vitehub/types`. Include `.vitehub/types/**/*.d.ts` in the application's `tsconfig.json` so TypeScript sees them.
