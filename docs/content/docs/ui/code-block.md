---
title: Code Block
description: "Show code, terminal output, logs, and diffs with a header, line numbers, and a copy button."
navigation.order: 15
navigation.group: Parts
icon: i-ph-code-light
---

`CodeBlock` shows code, terminal output, logs, and diffs. It has a header with a title and actions, optional line numbers and wrapping, and line variants for diffs and highlights. `useHighlightedCode()` colors the lines with [Shiki](https://shiki.style). The parts have the same names, props, and `data-slot` attributes as the [shadcn/ui Code Block](https://ui.shadcn.com/docs/components/code-block).

Syntax highlighting is optional and lives in a separate composable, so a block that only shows plain output stays small.

::component-preview{name="CodeBlockExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/code-block`:

```ts
import { CodeBlock, CodeBlockContent, useHighlightedCode } from "@vite-hub/ui";
```

The `@vite-hub/ui/code-block` entry also exports `useHighlightedCode` for [syntax highlighting](#syntax-highlighting).

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

`CodeBlockContent` takes plain text or a list of `CodeBlockLine` parts. Use lines when you need line variants or highlighted tokens.

## Features

- **Plain text stays plain.** Put text straight into `CodeBlockContent`. With `line-numbers`, the text is split into numbered lines.
- **It copies cleanly.** Line numbers and diff markers are not selectable, and blank lines stay in a copied selection.
- **It reads left to right.** The content always has `dir="ltr"`.
- **It highlights without WASM.** `useHighlightedCode` uses the Shiki JavaScript regex engine, loads each language the first time it is used, and shows the colors of terminal output.
- **It renders on the server.** The server and the first browser render show plain lines, so hydration matches. The colors follow after mount.
- **It follows the color mode.** Tokens use the GitHub light and dark themes and follow the `dark` class of Nuxt UI.
- **It scrolls by keyboard.** The content is focusable, and floating actions show on focus as well as on hover.

## Basic

Put plain text in `CodeBlockContent`. It renders as one text node.

::component-preview{name="CodeBlockBasicExample"}
::

## Header

`CodeBlockHeader` holds a `CodeBlockTitle` and `CodeBlockActions`. `CodeBlockCopyButton` copies its `value`.

::component-preview{name="CodeBlockHeaderExample"}
::

A long title truncates. To link the title to a file, wrap `CodeBlockTitle` in an anchor.

```vue
<CodeBlockHeader>
  <a href="/files/chat.post.ts">
    <CodeBlockTitle>server/api/chat.post.ts</CodeBlockTitle>
  </a>
</CodeBlockHeader>
```

## Actions

`CodeBlockActions` holds any number of buttons. For a wrap toggle, keep the state yourself and pass it to `wrap`. A download button can make a Blob URL from the text, so it needs no request.

::component-preview{name="CodeBlockActionsExample"}
::

```vue
<script setup lang="ts">
const wrap = ref(false);
</script>

<template>
  <CodeBlockActions>
    <UButton
      color="neutral"
      variant="ghost"
      size="xs"
      square
      icon="i-ph-text-align-left-light"
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

Without a header, put `CodeBlockActions` directly in `CodeBlock`. The actions float at the top end and show when the reader hovers over the block or moves focus into it. They always show on touch screens.

::component-preview{name="CodeBlockFloatingActionsExample"}
::

## Line Numbers

Add `line-numbers` to `CodeBlockContent`. Plain text is split into lines, and the numbers are not copied with a selection.

::component-preview{name="CodeBlockLineNumbersExample"}
::

## Start Line

Set `start-line` to number lines from a given line, for a snippet from the middle of a file. The gutter grows to fit the widest number.

::component-preview{name="CodeBlockStartLineExample"}
::

## Wrap

Long lines scroll by default. Add `wrap` to wrap them. This suits tool output and error messages. To let the reader toggle it, see [Actions](#actions).

::component-preview{name="CodeBlockWrapExample"}
::

## Highlighted Lines

Render each line as a `CodeBlockLine` and set `variant="highlighted"` on the lines to call out.

::component-preview{name="CodeBlockHighlightedLinesExample"}
::

## Diff

Set `variant="added"` or `variant="removed"` on a `CodeBlockLine`. Each one adds a plus or minus marker. To show a patch, split it into lines and read the variant from the first character.

::component-preview{name="CodeBlockDiffExample"}
::

## Height

Limit the height with a `max-h-*` class on `CodeBlockContent`. The content scrolls inside the block.

::component-preview{name="CodeBlockHeightExample"}
::

## Show More

`CodeBlockFooter` is a row below the content. For Show More, limit the content height while it is collapsed and put a ghost `xs` `UButton` in the footer.

::component-preview{name="CodeBlockShowMoreExample"}
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

Use `size="sm"` for tool output and [Trace](#trace) output. It has tighter padding and smaller text.

::component-preview{name="CodeBlockSizeExample"}
::

## Destructive

Use `variant="destructive"` for errors and failed output.

::component-preview{name="CodeBlockDestructiveExample"}
::

## Trace

Put a `CodeBlock` with `size="sm"` in `TraceCollapsibleContent` for tool and terminal output. Add `wrap` and a `max-h-64` class to `CodeBlockContent`, so long output wraps and scrolls inside the [Trace](/docs/ui/trace).

::component-preview{name="CodeBlockTraceExample"}
::

## Message

Put a `CodeBlock` between paragraphs in a [Message](/docs/ui/message).

::component-preview{name="CodeBlockMessageExample"}
::

## Syntax Highlighting

`useHighlightedCode(code, language)` highlights with [Shiki](https://shiki.style) and returns one node per line for `CodeBlockLine`. Render each node with `<component :is="line" />`.

::component-preview{name="CodeBlockHighlightingExample"}
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

Both arguments can be refs or getters, so the lines update when the code changes. Shiki uses its JavaScript regex engine, so there is no WASM to load. The server and the first browser render show plain lines, so hydration matches, and the colors follow after mount. Plain ANSI text drops its escape codes. Tokens use the GitHub light and dark themes and follow the `dark` class of Nuxt UI.

### Languages

Each language loads the first time it is used. A language that is not in the list renders as plain text. Call `useHighlightedCode` once for each block.

::component-preview{name="CodeBlockLanguagesExample"}
::

The supported languages are `bash`, `css`, `diff`, `html`, `javascript`, `json`, `jsx`, `markdown`, `python`, `sql`, `tsx`, `typescript`, `vue`, and `yaml`, with the aliases `js`, `ts`, `sh`, `shell`, `md`, and `yml`.

### Terminal Output

Pass `"ansi"` as the language to show the colors of terminal output. Without it, the escape codes show as text. Remove the escape codes from the value that you copy.

::component-preview{name="CodeBlockAnsiExample"}
::

## Accessibility

- `CodeBlockContent` is a `pre` with a `code` element and always sets `dir="ltr"`, so code reads left to right on a right-to-left page.
- `CodeBlockContent` is focusable, so keyboard users can scroll long lines. The block shows a focus ring.
- Floating actions show when focus is inside the block, not only on hover, so keyboard users can reach them.
- Line numbers and diff markers are not selectable and are not read as text.
- Diff lines have a plus or minus marker as well as a tint, so the change does not rely on color.
- `CodeBlockCopyButton` is labeled "Copy" and changes to "Copied". A polite live region announces the copy.
- Give a wrap toggle `aria-pressed`, so screen readers announce its state.
- Give a Show More button `aria-expanded`, and point `aria-controls` at the `id` of `CodeBlockContent`.

## API Reference

### CodeBlock

The surface that holds the header, the content, and the footer. Renders a `div` with `data-slot="code-block"`.

#### Props

| Prop      | Type                         | Default     | Description                                                   |
| --------- | ---------------------------- | ----------- | ------------------------------------------------------------- |
| `variant` | `"default" \| "destructive"` | `"default"` | The tone of the block.                                        |
| `size`    | `"default" \| "sm"`          | `"default"` | `"sm"` has tighter padding and smaller code, for tool output. |

### CodeBlockHeader

A row above the content for a title and actions. Has no props. Renders a `div` with `data-slot="code-block-header"`.

### CodeBlockTitle

A file name or a label, with an optional icon. It truncates. Has no props. Renders a `div` with `data-slot="code-block-title"`.

### CodeBlockActions

Holds buttons at the end of the header. As a direct child of `CodeBlock`, it floats over the code. Has no props. Renders a `div` with `data-slot="code-block-actions"`.

### CodeBlockCopyButton

A Nuxt UI `UButton` with `variant="ghost"` and `size="xs"` that copies `value` to the clipboard. Other attributes go to the button.

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

A row below the content, for example for a Show More button. Has no props. Renders a `div` with `data-slot="code-block-footer"`.

### useHighlightedCode

```ts
function useHighlightedCode(
  code: MaybeRefOrGetter<string>,
  language: MaybeRefOrGetter<string>,
): ShallowRef<VNode[]>;
```

Returns a shallow ref with one VNode per line. It holds plain lines on the server, until the first highlight pass after mount finishes, and for a language that is not in the list.

#### Parameters

| Argument   | Type                       | Description                                                                    |
| ---------- | -------------------------- | ------------------------------------------------------------------------------ |
| `code`     | `MaybeRefOrGetter<string>` | The code to highlight. A trailing newline is ignored.                          |
| `language` | `MaybeRefOrGetter<string>` | A language or alias from [Languages](#languages), or `"ansi"`. Case does not matter. |

## Related

- [Code view](/docs/ui/code-view) shows a whole file with a file header.
- [Diff](/docs/ui/diff) shows file and patch diffs.
- [Trace](/docs/ui/trace) puts tool output under a step.
