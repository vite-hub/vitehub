---
title: Markdown templates
description: Render predictable Markdown from explicit data, simple conditions, and reusable fragments.
navigation.order: 53
navigation.group: Application APIs
icon: i-vscode-icons-file-type-markdown
---

::agent-only{skill="markdown-template"}
Use Markdown Templates when an application needs predictable Markdown composition with data bindings, conditions, or fragments. The renderer does not evaluate JavaScript or read files implicitly.

Start with the [Markdown Template tutorial](/docs/reference/markdown-template-tutorial).

Keep input data explicit and validate it before rendering. Use the file integration only with explicit paths or `file:` URLs.

Prove interpolation, a false condition, a fragment, and a missing or invalid value. Compare the rendered Markdown with the expected output before sending it to email or an Agent.
::

`@vite-hub/markdown-template` fills Markdown with your data and conditions. It never runs JavaScript or reads files on its own. Use it for Agent Instructions, review prompts, and other generated documents that must keep your Markdown structure.

For a short working example, start with [Render your first Markdown template](/docs/reference/markdown-template-tutorial).

## Install

You need Node.js 22.18 or later.

```bash [Terminal]
pnpm add @vite-hub/markdown-template
```

## Import a template file

Put a `*.template.md` file next to the module that renders it. Importing the file gives you an async render function.

```md [server/agents/reviewer/prompt.template.md]
# Review {{ data.pullRequest.number }}

Title: {{ data.pullRequest.title }}
```

```ts [server/agents/reviewer/agent.ts] fragment
import renderPrompt from './prompt.template.md'

const prompt = await renderPrompt({
  pullRequest: { number: 611, title: 'Refine navigation' },
})
```

- ViteHub bundles only `*.template.md` files that you import directly. `@./partial.md` stays literal text and bundles nothing.
- The deployed app does not read these source files at runtime.
- The render function takes an optional `Record<string, unknown>` and returns `Promise<string>`.
- You can group templates in a folder such as `./templates/`. ViteHub does not discover it, so import each file. Several callers can import the same template from a shared path.

To pick a template at runtime, list the allowed names in a TypeScript map:

```ts [server/agents/reviewer/replies.ts] fragment
import renderFailure from './failure.template.md'
import renderSuccess from './success.template.md'

export const replies = {
  failure: renderFailure,
  success: renderSuccess,
} as const
```

The query form must end with exactly `?markdown-template`. Compound queries and hash fragments are not supported. If another Vite plugin resolves a template import to a virtual ID, or an ID with its own query or fragment, ViteHub leaves it for that plugin to load.

`vitehub()` sets up template imports. In a modular Vite config, add `hubMarkdownTemplate()` from `@vite-hub/markdown-template/vite`. Both write the module type to `.vitehub/types`. Your `tsconfig.json` must include it.

To share a section, render its template in TypeScript and pass the result as a Markdown fragment.

## Render a template string

`renderMarkdownTemplate()` returns Markdown. Pass values in `data`. The template reads them with Comark bindings such as `{{ data.title }}`.

```ts
import { renderMarkdownTemplate } from 'vite-hub/markdown-template'

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

The title renders as literal text with escaped asterisks. `Insert` adds the file list as real Markdown.

## Bind values and attributes

`{{ data.path }}` inserts a string, number, or boolean as escaped text. A missing, null, or non-scalar value fails the render. Paths read only own enumerable properties, plus array length. Use nested objects for dotted paths, such as `{ customer: { name: 'Acme' } }`.

For dynamic links and XML attributes, use Comark's colon-prefixed attributes:

```md
[Open review](){:href="data.reviewUrl"}

<policy :audience="data.audience">Review {{ data.title }}.</policy>
```

Build the full URL in TypeScript. ViteHub encodes characters that could break the Markdown. It rejects unsafe or unclear links, such as `javascript:`, `data:`, control characters, and malformed percent escapes. Bound XML attributes are escaped. Bindings and components also work in multiline XML blocks.

## Select conditional content

Use `:condition` for a truthy check, or `:value` with comparison props. A `:` prefix binds a data path or parses a JSON literal. Comparison props without it are plain strings. `condition` and `value` must have the `:` prefix: `::if{condition="data.trial"}` throws `MARKDOWN_TEMPLATE_R0024`.

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

- `eq` and `neq` use strict equality.
- `gt`, `gte`, `lt`, and `lte` compare two numbers or two strings.
- All comparisons must match. A missing value or binding never matches, not even `neq`.
- `value` with no comparison is a truthy check. A falsy `condition` always hides the branch.
- The first matching branch wins. Other branches are not evaluated.
- Close each component, including each `else-if` and `else`, with its own `::` line. Nested chains follow the same Comark rules.
- `else` has no props and must be last.

Conditions do not run JavaScript, call functions, or read globals. Compute compound logic in TypeScript and pass the boolean.

## Insert trusted Markdown

Use `{{ data.summary }}` for plain text and `:insert{:markdown="data.summary"}` to keep Markdown formatting. For `summary: '**Ready**'`:

| Template | Result |
| --- | --- |
| `{{ data.summary }}` | Literal text `**Ready**`, with the asterisks escaped. |
| `:insert{:markdown="data.summary"}` | Markdown `**Ready**`, which displays as **Ready**. |

`Insert` is a ViteHub component in Comark syntax. `:markdown` reads a string from your data. To insert headings, lists, or several paragraphs, put it on its own line with blank lines around it:

```md
:insert{:markdown="data.summary"}
```

The container form also works:

```md
::insert{:markdown="data.summary"}
::
```

Next to punctuation, Comark does not see the colon shorthand. Use the paired form:

```md
Use (<Insert :markdown="data.policy"></Insert>).
```

- A fragment must be a string.
- An inline fragment must be inline content. Block Markdown in an inline position fails the render.
- Comark parses the fragment without template bindings or components, so template syntax inside it is not run.
- Comark may change the spelling of literal component attributes.
- `@./policy.md` stays literal. Render shared templates in TypeScript and pass the result as fragment data.

::warning
Fragments are trusted input. The renderer does not make untrusted instructions safe for an Agent. Build or validate fragment content before you render it.
::

## Rendering behavior

Comark parses, escapes, renders components, and writes the output. It may change whitespace, quote style, or component syntax, so the output is not byte-for-byte your source. Bindings and components in code spans and code blocks stay literal.

The renderer does no file or network I/O. It has no loops, no JavaScript evaluation, and no public syntax-tree hooks. Prepare repeated content and compound conditions in TypeScript.

## Migrate existing templates

The new syntax breaks old templates in direct render calls, imported files, Email, Agent Instructions, and progress summaries.

| Previous syntax | Comark syntax |
| --- | --- |
| `{{ name }}` | `{{ data.name }}` |
| `{{{ summary }}}` | `:insert{:markdown="data.summary"}` |
| `::if{enabled}` | `::if{:condition="data.enabled"}` |
| `::if{status === 'ready'}` | `::if{:value="data.status" eq="ready"}` |
| `::if{enabled && !draft}` | Compute `visible = enabled && !draft` in TypeScript, then use `::if{:condition="data.visible"}`. |
| `[Open]({{ url }})` | `[Open](){:href="data.url"}` |
| `<policy audience="{{ audience }}">` | `<policy :audience="data.audience">` |

`else-if` takes the same props as `if`. `else` takes none. Close every branch with `::`, then close the outer `if`. ViteHub does not translate old syntax. The render function and its `{ data }` option did not change.

A binding that fills a whole link destination, such as `[Open]({{ data.url }})`, fails with `MARKDOWN_TEMPLATE_R0033`. Comark does not read that form as a link and would output the brackets as text.

## Render options

`renderMarkdownTemplate(template, options?)` returns `Promise<string>`. Options:

- `data?: Record<string, unknown>`, default `{}`.
- `plugins?: ComarkPlugin[]` adds Comark syntax handlers.

## Related pages

- [Agent Instructions](/docs/agents/instructions)
- [Import paths](/docs/reference/import-paths)
