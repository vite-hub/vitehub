# @vite-hub/markdown-template

`@vite-hub/markdown-template` turns a Markdown template string and explicit data into Markdown. It supports escaped scalar values, trusted Markdown fragments, bounded conditions, and caller-resolved imports. The direct renderer does not evaluate JavaScript or read files and URLs on its own.

Use `renderMarkdownFile()` for a local Markdown path. Use `renderMarkdownTemplate()` when your application already has the template string.

## Install

```sh
pnpm add @vite-hub/markdown-template
```

The package requires Node 24 or newer.

## Render a template string

Pass the complete data object with the template. Double braces insert a scalar as escaped Markdown text. Triple braces insert a Markdown fragment that your application trusts.

```ts
import { renderMarkdownTemplate } from "@vite-hub/markdown-template"

const markdown = await renderMarkdownTemplate([
  "# Review {{ number }}",
  "",
  "Title: {{ title }}",
  "",
  "{{{ files }}}",
].join("\n"), {
  data: {
    files: "## Files\n\n- `README.md`",
    number: 42,
    title: "*Draft*",
  },
})

console.log(markdown)
```

The call returns this exact string:

```md
# Review 42

Title: \*Draft\*

## Files

- `README.md`
```

`title` cannot create emphasis because `{{ title }}` escapes its Markdown syntax. `files` keeps its heading and list because `{{{ files }}}` parses the value as Markdown.

## Choose the input form deliberately

### Escape scalar data

Use `{{ path.to.value }}` for a string, number, or boolean. Paths read own properties only. A missing path, `null`, an array, or an object rejects the render instead of producing an empty string.

Scalar bindings are Markdown text, not raw source. The renderer also HTML-escapes scalar bindings inside quoted XML-style attributes.

```md
Customer: {{ customer.name }}

<policy audience="{{ audience }}">Review the change.</policy>
```

A scalar may occupy a complete inline link destination:

```md
[Open review]({{ reviewUrl }})
```

The renderer URI-encodes characters that would change the Markdown structure and rejects unsafe or ambiguous destinations, including `javascript:` and `data:` URLs, control characters, malformed percent escapes, and path backslashes in schemeless destinations or `file:`, `ftp:`, `http:`, `https:`, `ws:`, and `wss:` URLs.

A binding inside only part of a destination does not create a link. For example, `[Open review](/reviews/{{ id }})` renders as literal, non-clickable text. Construct the complete URL in data and bind the whole destination instead:

```ts
const data = { reviewUrl: `/reviews/${id}` }
```

```md
[Open review]({{ reviewUrl }})
```

### Insert trusted Markdown

Use `{{{ path.to.markdown }}}` only for a string that may add Markdown structure. A block fragment must occupy its own block; the renderer rejects block Markdown placed inside an inline sentence.

The renderer does not evaluate template syntax inside a fragment again. Bindings, conditions, and imports in the fragment remain literal. This stops accidental recursive templating, but it does not make an untrusted fragment safe for an Agent or another model. Validate or construct fragments before passing them to the renderer.

### Select a condition

Conditional sections read data paths and literals. They support `!`, parentheses, `&&`, `||`, and equality or inequality with `===`, `!==`, `==`, or `!=`. All four equality operators use strict JavaScript equality semantics.

```md
::if{pullRequest.available && !pullRequest.draft}
Review {{ pullRequest.title }}.
::else-if{pullRequest.draft}
Wait for the pull request to leave draft.
::else
No pull request is available.
::
```

Conditions cannot call functions, read globals, or traverse inherited properties. The renderer rejects malformed branches and unsafe expressions.

### Authorize every import

An import token such as `@./policy.md` stays literal unless you pass `resolveImport`. The resolver receives the relative specifier and the canonical ID of the importing template. It must return both the imported template and its canonical ID:

```ts
const markdown = await renderMarkdownTemplate("# Review\n\n@./policy.md", {
  sourceId: "/templates/review.md",
  async resolveImport(specifier, importer) {
    if (specifier !== "./policy.md" || importer !== "/templates/review.md") {
      throw new Error("Template import is not allowed")
    }

    return {
      id: "/templates/policy.md",
      template: "Use the repository review policy.",
    }
  },
})
```

The renderer accepts relative imports only. It rejects absolute paths, URLs, globs, missing resolutions, cycles, and imports deeper than `maxImportDepth`, which defaults to `4`.

Imports resolve before conditions run. Your resolver must authorize an import even when it appears inside a branch that the data will not select. The resolver also owns filesystem or network access, caching, and canonical path handling. The package performs none of that I/O implicitly.

## Render a Markdown file

Create `review.md`:

```md
# Review {{ number }}

@./policy.md

{{{ summary }}}
```

Create `policy.md` beside it:

```md
Check correctness and regression coverage.
```

```ts
import { renderMarkdownFile } from "@vite-hub/markdown-template"

const markdown = await renderMarkdownFile(new URL("./review.md", import.meta.url), {
  data: { number: 42, summary: "Ready for review." },
})
```

Applications can import the same function from `vite-hub/markdown-template`.

`renderMarkdownFile(path, options?)` accepts a filesystem path string or a `file:` URL and returns `Promise<string>`. Its `RenderMarkdownFileOptions` accepts `data` and `maxImportDepth`, which defaults to `4`. Relative path strings use the process working directory. File URLs constructed with `import.meta.url` use the executing module's directory. HTTP URLs are not supported.

Each call reads the file and its relative fragments. Symlinks resolve to canonical paths; nested fragments resolve beside their canonical importer. Missing files reject with the filesystem error. Conditions, escaping, code literals, and import depth and cycle checks use the same renderer as template strings. Imports resolve before conditions, including imports in unselected branches.

File loading uses the host filesystem permissions. Trusted templates may import parent directories through `../` or symlinks. For a restricted file tree or application storage, use the string renderer with your own `resolveImport`.

### Ship the file tree

Include the Markdown files and fragments in your deployed server files. ViteHub does not automatically bundle or copy paths passed to `renderMarkdownFile()`. After a build, `import.meta.url` refers to the emitted module; place the files beside that module as specified by the URL, or pass a configured absolute path. A host without local files must supply content to the string renderer through application storage, a Workspace, or a Source.

### Breaking migration

Callable `*.template.md` imports, the `?markdown-template` query, and `hubMarkdownTemplate()` are removed. Rename files to `.md`, replace imports with `renderMarkdownFile(path, { data })`, and ship the files and fragments. Remove the template Vite plugin and obsolete `.vitehub/types/markdown-template.d.ts` declarations. File errors now occur when rendering. The string API is unchanged.

## Know what the renderer does not preserve

The renderer parses and serializes through Comark, then trims whitespace outside the document. It preserves Markdown structure, but it is not a byte-for-byte source formatter. Template syntax inside code spans, fenced code blocks, and indented code blocks stays literal.

The direct renderer has no loops, helpers, macros, compile step, implicit filesystem access, HTML renderer, or public syntax-tree hooks. Build repeated content in application code and pass the completed text as a trusted fragment.

## Public imports

| Import | Purpose |
| --- | --- |
| `@vite-hub/markdown-template` | `renderMarkdownFile()`, `renderMarkdownTemplate()`, and their public option and import-resolver types. |

## Learn more

- [Markdown templates](https://vitehub.dev/docs/reference/markdown-templates) documents every syntax form and render option.
- [Import paths](https://vitehub.dev/docs/reference/import-paths) lists the public ViteHub package entrypoints.
- [Agent Instructions](https://vitehub.dev/docs/agents/instructions) shows where rendered Markdown fits in an Agent Definition.
