# @vite-hub/markdown-template

`@vite-hub/markdown-template` turns a Markdown template string and explicit data into Markdown. It supports escaped scalar values, trusted Markdown fragments, and bounded conditions. The direct renderer does not evaluate JavaScript or read files and URLs on its own.

Use `renderMarkdownFile()` for a local Markdown path. Use `renderMarkdownTemplate()` when your application already has the template string.

## Install

```sh
pnpm add @vite-hub/markdown-template
```

The package requires Node 24 or newer.

## Render a template string

Pass the complete data object with the template. Double braces insert a scalar as escaped Markdown text. Use the `Insert` component for trusted Markdown fragments.

```ts
import { renderMarkdownTemplate } from "@vite-hub/markdown-template"

const markdown = await renderMarkdownTemplate([
  "# Review {{ data.number }}",
  "",
  "Title: {{ data.title }}",
  "",
  ":insert{:markdown=\"data.files\"}",
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

`title` cannot create emphasis because `{{ data.title }}` escapes its Markdown syntax. `files` keeps its heading and list because the `Insert` component parses the trusted value as Markdown.

## Choose the input form deliberately

### Escape scalar data

Use `{{ data.path.to.value }}` for a string, number, or boolean. Paths read own enumerable properties only, plus array length. A missing path, `null`, an array, or an object rejects the render instead of producing an empty string.

Dotted keys resolve by the longest matching own key before nested traversal. For `{ "support.customer": "Acme", "support.customer.name": "Primary" }`, both `data.support.customer` and `data.support.customer.name` remain addressable regardless of key insertion order. If a longer object prefix has no matching descendant, lookup continues through shorter prefixes without merging or mutating the objects. Exact dotted keys also take precedence over nested values, including array length.

Scalar bindings are Markdown text, not raw source. The renderer also HTML-escapes scalar bindings inside quoted XML-style attributes.

```md
Customer: {{ data.customer.name }}

<policy :audience="data.audience">Review the change.</policy>
```

A scalar may occupy a complete inline link destination:

```md
[Open review](){:href="data.reviewUrl"}
```

The renderer URI-encodes characters that would change the Markdown structure and rejects unsafe or ambiguous destinations, including `javascript:` and `data:` URLs, control characters, malformed percent escapes, and path backslashes in schemeless destinations or `file:`, `ftp:`, `http:`, `https:`, `ws:`, and `wss:` URLs.

A binding inside only part of a destination does not create a link. For example, `[Open review](/reviews/{{ data.id }})` renders as literal, non-clickable text. Construct the complete URL in data and bind the whole destination instead:

```ts
const data = { reviewUrl: `/reviews/${id}` }
```

```md
[Open review](){:href="data.reviewUrl"}
```

### Insert trusted Markdown

Use `:insert{:markdown="data.path.to.markdown"}` only for a string that may add Markdown structure. A block fragment must occupy its own block; the renderer rejects block Markdown placed inside an inline sentence.

The renderer does not evaluate template syntax inside a fragment again. Bindings, conditions, and imports in the fragment remain literal. This stops accidental recursive templating, but it does not make an untrusted fragment safe for an Agent or another model. Validate or construct fragments before passing them to the renderer.

### Select a condition

Conditional sections read a data path and compare it with a literal using Comark's supported comparison props: `eq`, `neq`, `gt`, `gte`, `lt`, and `lte`. Prefix a prop with `:` when its value is another binding or JSON value. They do not parse JavaScript expressions.

```md
::if{:condition="data.available"}
Review {{ data.pullRequest.title }}.
::else-if{:condition="data.draft"}
Wait for the pull request to leave draft.
::else
No pull request is available.
::
::
::
```

Conditions cannot call functions, read globals, or traverse inherited properties. The renderer rejects malformed branches and unsafe expressions.

### Keep import references literal

References such as `@./policy.md` and `@workspace.policy` remain literal text. Render related Markdown explicitly with `renderMarkdownFile()` or pass trusted content through the `:insert` binding; this package does not recursively resolve template imports.
