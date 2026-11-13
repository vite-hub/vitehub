---
title: Code Block
description: "Show code, terminal output, logs, and diffs with a header, line numbers, and a copy button."
navigation.order: 15
navigation.group: Parts
icon: i-lucide-code
---

`CodeBlock` shows code, terminal output, logs, and diffs. It has a header with a title and actions, optional line numbers and wrapping, and line variants for diffs and highlights. The parts match the names, props, and `data-slot` attributes of the [shadcn/ui Code Block](https://ui.shadcn.com/docs/components/code-block).

Syntax highlighting with [Shiki](https://shiki.style) is optional and lives in a separate composable, `useHighlightedCode()`, so a plain block stays small.

::example{name="CodeBlockExample" height=22}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui`:

```ts
import { CodeBlock, CodeBlockContent, useHighlightedCode } from "@vite-hub/ui";
```

`@vite-hub/ui` also exports `useHighlightedCode` for [syntax highlighting](#syntax-highlighting).

## Usage

```ts
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockFooter,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@vite-hub/ui";
```

```vue
<template>
  <CodeBlock>
    <CodeBlockHeader>
      <CodeBlockTitle>Terminal</CodeBlockTitle>
      <CodeBlockActions>
        <CodeBlockCopyButton :value="output" />
      </CodeBlockActions>
    </CodeBlockHeader>
    <CodeBlockContent>{{ output }}</CodeBlockContent>
  </CodeBlock>
</template>
```

## Composition

```text
CodeBlock
├── CodeBlockHeader
│   ├── CodeBlockTitle
│   └── CodeBlockActions
│       └── CodeBlockCopyButton
├── CodeBlockActions (floating, when there is no header)
├── CodeBlockContent
│   └── CodeBlockLine
└── CodeBlockFooter
```

`CodeBlockContent` takes plain text or `CodeBlockLine` parts. Use lines for line variants or highlighted tokens.

## Features

- **Plain text stays plain.** With `line-numbers`, it splits into numbered lines.
- **Clean copy.** Line numbers and diff markers are not selectable, and blank lines stay in a copied selection.
- **Left to right.** The content always has `dir="ltr"`.
- **No WASM.** `useHighlightedCode` uses the Shiki JavaScript regex engine, loads each language on first use, and shows terminal colors.
- **Server render.** The server and first browser render show plain lines, so hydration matches. Colors follow after mount.
- **Color mode.** Tokens use the GitHub light and dark themes and follow the Nuxt UI `dark` class.
- **Keyboard scroll.** The content is focusable, and floating actions show on focus and hover.

## Basic

Put plain text in `CodeBlockContent`. It renders as one text node.

::example{name="CodeBlockBasicExample" height=15}
::

## Header

`CodeBlockHeader` holds a `CodeBlockTitle` and `CodeBlockActions`. `CodeBlockCopyButton` copies its `value`.

::example{name="CodeBlockHeaderExample" height=10}
::

A long title truncates. To link it to a file, wrap `CodeBlockTitle` in an anchor.

```vue
<CodeBlockHeader>
  <a href="/files/chat.post.ts">
    <CodeBlockTitle>server/api/chat.post.ts</CodeBlockTitle>
  </a>
</CodeBlockHeader>
```

## Actions

`CodeBlockActions` holds any number of buttons. For a wrap toggle, keep the state yourself and pass it to `wrap`. A download button can make a Blob URL from the text, with no request.

::example{name="CodeBlockActionsExample" height=18}
::

```vue
<script setup lang="ts">
const wrap = ref(false);
const output = "pnpm test";
</script>

<template>
  <CodeBlockActions>
    <UButton
      color="neutral"
      variant="ghost"
      size="xs"
      square
      icon="i-lucide-text-align-start"
      aria-label="Wrap lines"
      :aria-pressed="wrap"
      @click="wrap = !wrap"
    />
    <CodeBlockCopyButton :value="output" />
  </CodeBlockActions>
  <CodeBlockContent :wrap="wrap">{{ output }}</CodeBlockContent>
</template>
```

## Floating Actions

Without a header, put `CodeBlockActions` directly in `CodeBlock`. The actions float at the top end and show on hover or focus. They always show on touch screens.

::example{name="CodeBlockFloatingActionsExample" height=12}
::

## Line Numbers

Add `line-numbers` to `CodeBlockContent`. Plain text splits into lines, and the numbers are not copied.

::example{name="CodeBlockLineNumbersExample" height=13}
::

## Start Line

Set `start-line` for a snippet from the middle of a file. The gutter grows to fit the widest number.

::example{name="CodeBlockStartLineExample" height=20}
::

## Wrap

Long lines scroll by default. Add `wrap` to wrap them, for example for tool output and errors. For a toggle, see [Actions](#actions).

::example{name="CodeBlockWrapExample" height=13}
::

## Highlighted Lines

Render each line as a `CodeBlockLine` and set `variant="highlighted"` on the lines to call out.

::example{name="CodeBlockHighlightedLinesExample" height=15}
::

## Diff

Set `variant="added"` or `variant="removed"` on a `CodeBlockLine` to add a plus or minus marker. For a patch, split it into lines and read the variant from the first character.

::example{name="CodeBlockDiffExample" height=12}
::

## Height

Add a `max-h-*` class to `CodeBlockContent`. The content scrolls inside the block.

::example{name="CodeBlockHeightExample" height=15}
::

## Show More

`CodeBlockFooter` is a row below the content. For Show More, limit the height while collapsed and put a ghost `xs` `UButton` in the footer.

::example{name="CodeBlockShowMoreExample" height=21}
::

```vue
<script setup lang="ts">
const expanded = ref(false);
const id = useId();
</script>

<template>
  <CodeBlockContent :id="id" :class="expanded ? undefined : 'max-h-64 overflow-y-hidden'">
    {{ code }}
  </CodeBlockContent>
  <CodeBlockFooter class="justify-center">
    <UButton
      color="neutral"
      variant="ghost"
      size="xs"
      :aria-expanded="expanded"
      :aria-controls="id"
      @click="expanded = !expanded"
    >
      {{ expanded ? "Show less" : "Show more" }}
    </UButton>
  </CodeBlockFooter>
</template>
```

## Size

Use `size="sm"`, with tighter padding and smaller text, for tool and [Trace](#trace) output.

::example{name="CodeBlockSizeExample" height=18}
::

## Destructive

Use `variant="destructive"` for errors and failed output.

::example{name="CodeBlockDestructiveExample" height=10}
::

## Trace

Put a `CodeBlock` with `size="sm"` in `TraceCollapsibleContent` for tool and terminal output. Add `wrap` and `max-h-64` to `CodeBlockContent`, so long output wraps and scrolls inside the [Trace](/docs/ui/trace).

::example{name="CodeBlockTraceExample" height=16}
::

## Message

Put a `CodeBlock` between paragraphs in a [Message](/docs/ui/message).

::example{name="CodeBlockMessageExample" height=28}
::

## Syntax Highlighting

`useHighlightedCode(code, language)` highlights with [Shiki](https://shiki.style) and returns one node per line for `CodeBlockLine`. Render each node with `<component :is="line" />`.

::example{name="CodeBlockHighlightingExample" height=12}
::

```vue
<script setup lang="ts">
import { useHighlightedCode } from "@vite-hub/ui";

const lines = useHighlightedCode(code, "json");
</script>

<template>
  <CodeBlock>
    <CodeBlockContent>
      <CodeBlockLine v-for="(line, index) in lines" :key="index">
        <component :is="line" />
      </CodeBlockLine>
    </CodeBlockContent>
  </CodeBlock>
</template>
```

Both arguments can be refs or getters, so the lines update when the code changes. Plain ANSI text drops its escape codes. See [Features](#features) for the engine, server render, and themes.

### Languages

Each language loads on first use. A language not in the list renders as plain text. Call `useHighlightedCode` once per block.

::example{name="CodeBlockLanguagesExample" height=25}
::

Supported languages: `bash`, `css`, `diff`, `html`, `javascript`, `json`, `jsx`, `markdown`, `python`, `sql`, `tsx`, `typescript`, `vue`, and `yaml`, with the aliases `js`, `ts`, `sh`, `shell`, `md`, and `yml`.

### Terminal Output

Pass `"ansi"` as the language to show terminal colors. Without it, escape codes show as text. Remove escape codes from the value you copy.

::example{name="CodeBlockAnsiExample" height=17}
::

## Accessibility

- `CodeBlockContent` is a `pre` with a `code` element and always sets `dir="ltr"`, so code reads left to right on a right-to-left page.
- `CodeBlockContent` is focusable, with a focus ring, so keyboard users can scroll long lines.
- Floating actions show on focus too, so keyboard users can reach them.
- Line numbers and diff markers are not selectable or read as text.
- Diff lines have a plus or minus marker besides the tint, so they do not rely on color.
- `CodeBlockCopyButton` is labeled "Copy", then "Copied". A polite live region announces it.
- Give a wrap toggle `aria-pressed` so screen readers announce its state.
- Give a Show More button `aria-expanded`, and point `aria-controls` at the `id` of `CodeBlockContent`.

## API Reference

### CodeBlock

Holds the header, content, and footer. Renders a `div` with `data-slot="code-block"`.

#### Props

| Prop      | Type                         | Default     | Description                                                   |
| --------- | ---------------------------- | ----------- | ------------------------------------------------------------- |
| `variant` | `"default" \| "destructive"` | `"default"` | The tone of the block.                                        |
| `size`    | `"default" \| "sm"`          | `"default"` | `"sm"` has tighter padding and smaller code, for tool output. |

### CodeBlockHeader

A row above the content for a title and actions. No props. Renders a `div` with `data-slot="code-block-header"`.

### CodeBlockTitle

A file name or label, with an optional icon. It truncates. No props. Renders a `div` with `data-slot="code-block-title"`.

### CodeBlockActions

Buttons at the end of the header. As a direct child of `CodeBlock`, it floats over the code. No props. Renders a `div` with `data-slot="code-block-actions"`.

### CodeBlockCopyButton

A ghost `xs` Nuxt UI `UButton` that copies `value` to the clipboard. Other attributes go to the button.

#### Props

| Prop    | Type     | Default  | Description       |
| ------- | -------- | -------- | ----------------- |
| `value` | `string` | Required | The text to copy. |

### CodeBlockContent

The `pre` that scrolls or wraps. A `class` such as `max-h-48` goes to the `pre`.

#### Props

| Prop          | Type      | Default | Description                                        |
| ------------- | --------- | ------- | -------------------------------------------------- |
| `wrap`        | `boolean` | `false` | Wraps long lines instead of scrolling.             |
| `lineNumbers` | `boolean` | `false` | Numbers each line. Plain text is split into lines. |
| `startLine`   | `number`  | `1`     | The number of the first line.                      |

### CodeBlockLine

One line of code.

#### Props

| Prop      | Type                                                 | Default     | Description            |
| --------- | ---------------------------------------------------- | ----------- | ---------------------- |
| `variant` | `"default" \| "added" \| "removed" \| "highlighted"` | `"default"` | The state of the line. |

### CodeBlockFooter

A row below the content, such as for Show More. No props. Renders a `div` with `data-slot="code-block-footer"`.

### useHighlightedCode

```ts fragment
function useHighlightedCode(
  code: MaybeRefOrGetter<string>,
  language: MaybeRefOrGetter<string>,
): ShallowRef<VNode[]>;
```

Returns a shallow ref with one VNode per line. It holds plain lines on the server, until the first highlight after mount, and for unlisted languages.

#### Parameters

| Argument   | Type                       | Description                                                                    |
| ---------- | -------------------------- | ------------------------------------------------------------------------------ |
| `code`     | `MaybeRefOrGetter<string>` | The code to highlight. A trailing newline is ignored.                          |
| `language` | `MaybeRefOrGetter<string>` | A language or alias from [Languages](#languages), or `"ansi"`. Case does not matter. |

## Related

- [Code view](/docs/ui/code-view) shows a whole file with a file header.
- [Diff](/docs/ui/diff) shows file and patch diffs.
- [Trace](/docs/ui/trace) puts tool output under a step.
