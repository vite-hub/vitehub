# @vite-hub/markdown-template

Render Markdown with Comark bindings and ViteHub components for conditions and trusted fragments.

```sh
pnpm add @vite-hub/markdown-template
```

The package requires Node.js 24 or later.

## Render a template string

`renderMarkdownTemplate()` returns Markdown. Pass values through `data`; templates read them with Comark bindings such as `{{ data.title }}`.

```ts
import { renderMarkdownTemplate } from '@vite-hub/markdown-template'

const template = `# Review {{ data.number }}

::if{:value="data.status" eq="ready"}
Review {{ data.title }}.
::else
Wait for the author.
::
::

:insert{:markdown="data.files"}`

const markdown = await renderMarkdownTemplate(template, {
  data: {
    number: 42,
    status: 'ready',
    title: '*Draft*',
    files: '- README.md\n- package.json',
  },
})
```

The title renders as literal text, with its asterisks escaped. The `Insert` component inserts the file list as Markdown structure.

## Bind values and attributes

`{{ data.path }}` inserts a string, number, or boolean as escaped Markdown text. Missing, null, and non-scalar values reject the render. Data paths read own properties only. Use nested objects for dotted paths, such as `{ customer: { name: 'Acme' } }`.

Use Comark's colon-prefixed attributes for dynamic destinations and XML attributes:

```md
[Open review](){:href="data.reviewUrl"}

<policy :audience="data.audience">Review {{ data.title }}.</policy>
```

Build the complete URL in TypeScript. ViteHub encodes characters that could change its Markdown structure and rejects unsafe or ambiguous destinations, including `javascript:`, `data:`, control characters, and malformed percent escapes. Bound XML attributes escape attribute characters. Template bindings and components also work inside multiline XML blocks.

## Select conditional content

Use `condition` for a truthy check, or `value` with comparison props. Prefix a prop with `:` to bind a data path or parse a JSON literal. Unprefixed props are literal strings.

```md
::if{:condition="data.enabled" :value="data.count" :gte="2" :lt="5"}
Show the small active batch.
::else-if{:value="data.status" eq="paused"}
The batch is paused.
::else
No active batch.
::
::
::
```

`eq` and `neq` use strict equality. `gt`, `gte`, `lt`, and `lte` compare two numbers or two strings of the same type. All supplied comparisons must match. A missing value or expected binding never satisfies a comparison, including `neq`. With no comparison, `value` is a truthy check. An explicit falsy `condition` always hides the branch.

The renderer selects the first matching branch and does not evaluate values or fragments in other branches. Close each component with its own `::` line, including each `else-if` and `else` component. Nested chains use the same Comark container rules. An `else` has no props and must be last.

Compute compound logic in TypeScript and pass its boolean result. Conditions do not evaluate JavaScript expressions, call functions, or read globals.

## Insert trusted Markdown

Use `{{ data.summary }}` for plain text and `:insert{:markdown="data.summary"}` to preserve Markdown formatting. For `summary: '**Ready**'`:

| Template | Result |
| --- | --- |
| `{{ data.summary }}` | Literal text `**Ready**`, with the asterisks escaped. |
| `:insert{:markdown="data.summary"}` | Markdown `**Ready**`, which displays as **Ready**. |

`Insert` is a ViteHub component using Comark syntax. The `:markdown` prop reads a string from your data. Put it on its own line, separated by blank lines, to insert headings, lists, or multiple paragraphs:

```md
:insert{:markdown="data.summary"}
```

The container form also works:

```md
::insert{:markdown="data.summary"}
::
```

Use a paired component beside punctuation, where Comark's colon shorthand is not recognized:

```md
Use (<Insert :markdown="data.policy"></Insert>).
```

A fragment must be a string. An inline fragment must parse as inline content; block Markdown in an inline position rejects the render. Fragment content is parsed and serialized by Comark without template components or bindings, so its template syntax is not evaluated recursively. Comark may normalize the spelling of literal component attributes.

Fragments are trusted input. This rendering boundary does not make untrusted instructions safe for an Agent. Construct or validate fragment content before rendering it.

Text such as `@./policy.md` stays literal. Compose shared templates in TypeScript and pass their rendered Markdown as fragment data.

## Rendering behavior

Comark owns Markdown parsing, escaping, component rendering, and serialization. It may normalize whitespace, quote styles, or component syntax. This is not a byte-for-byte source formatter. Bindings and components inside code spans, fenced code, and indented code stay literal.

The renderer performs no filesystem or network I/O. It has no loops, JavaScript expression evaluator, or public syntax-tree hooks. Prepare repeated content and compound conditions in TypeScript.

## Migrate existing templates

This is a breaking syntax change for direct render calls, imported template files, Email, Agent Instructions, and progress-summary templates.

| Previous syntax | Comark syntax |
| --- | --- |
| `{{ name }}` | `{{ data.name }}` |
| `{{{ summary }}}` | `:insert{:markdown="data.summary"}` |
| `::if{enabled}` | `::if{:condition="data.enabled"}` |
| `::if{status === 'ready'}` | `::if{:value="data.status" eq="ready"}` |
| `::if{enabled && !draft}` | Compute `visible = enabled && !draft` in TypeScript, then use `::if{:condition="data.visible"}`. |
| `[Open]({{ url }})` | `[Open](){:href="data.url"}` |
| `<policy audience="{{ audience }}">` | `<policy :audience="data.audience">` |

`else-if` uses the same props as `if`; `else` has no props. Add a closing `::` for every branch component, followed by the closing fence for the outer `if`. Old syntax is not translated. The render function and its `{ data }` option are unchanged.

## Import template files with Vite

The direct renderer above has no build-tool requirement. If the template is a source file, register `hubMarkdownTemplate()` and import it directly:

```ts
// vite.config.ts
import { hubMarkdownTemplate } from "@vite-hub/markdown-template/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubMarkdownTemplate()],
})
```

Create `review.template.md`:

```md
# Review {{ data.number }}

:insert{:markdown="data.summary"}
```

```ts
import renderReview from "./review.template.md"

const markdown = await renderReview({
  number: 42,
  summary: "Ready for review.",
})
```

Vite bundles each directly imported template before deployment. The generated application does not read those source files at runtime. The plugin also writes the `*.template.md` module declaration under `.vitehub/types`; include `.vitehub/types/**/*.d.ts` in the application TypeScript configuration.

The combined [`vite-hub`](https://www.npmjs.com/package/vite-hub) preset installs this integration already.

## Public imports

| Import | Purpose |
| --- | --- |
| `@vite-hub/markdown-template` | `renderMarkdownTemplate()` and its public option type. |
| `@vite-hub/markdown-template/vite` | `hubMarkdownTemplate()` and direct `*.template.md` imports. |

## Learn more

- [Markdown templates](https://vitehub.dev/docs/reference/markdown-templates) documents every syntax form and render option.
- [Import paths](https://vitehub.dev/docs/reference/import-paths) lists the public ViteHub package entrypoints.
- [Agent Instructions](https://vitehub.dev/docs/agents/instructions) shows where rendered Markdown fits in an Agent Definition.
