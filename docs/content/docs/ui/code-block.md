---
title: Code Block
description: "Show code, terminal output, logs, and diffs with a header, line numbers, and a copy button."
navigation.order: 15
navigation.group: Parts
icon: i-ph-code-light
---

`CodeBlock` shows code, terminal output, logs, and diffs. It has a header with a title and actions, optional line numbers and wrapping, and line variants for diffs and highlights. `useHighlightedCode()` colors the lines with [Shiki](https://shiki.style). The parts have the same names, props, and `data-slot` attributes as the [shadcn/ui Code Block](https://ui.shadcn.com/docs/components/code-block).

::component-preview{name="CodeBlockExample"}
::

## Usage

```vue
<script setup lang="ts">
import { useHighlightedCode } from "@vite-hub/ui";

const code = `export default defineEventHandler(() => "ok");`;
const lines = useHighlightedCode(code, "ts");
</script>

<template>
  <CodeBlock>
    <CodeBlockHeader>
      <CodeBlockTitle>server/api/health.ts</CodeBlockTitle>
      <CodeBlockActions>
        <CodeBlockCopyButton :value="code" />
      </CodeBlockActions>
    </CodeBlockHeader>
    <CodeBlockContent>
      <CodeBlockLine v-for="(line, index) in lines" :key="index">
        <component :is="line" />
      </CodeBlockLine>
    </CodeBlockContent>
  </CodeBlock>
</template>
```

The parts compose as follows:

```text
CodeBlock
├── CodeBlockHeader
│   ├── CodeBlockTitle
│   └── CodeBlockActions
│       └── CodeBlockCopyButton
├── CodeBlockContent
│   └── CodeBlockLine
└── CodeBlockFooter
```

Put plain text straight into `CodeBlockContent`. With `line-numbers`, plain text is split into numbered lines. Put `CodeBlockActions` directly in `CodeBlock`, without a header, to float the actions over the code. They show on hover and focus.

### Diff and tool output

Set `variant` on a line to mark it as added, removed, or highlighted. Use `size="sm"` for tool output in a [Trace](/docs/ui/trace), and `variant="destructive"` for errors.

::component-preview{name="CodeBlockDiffExample"}
::

### Syntax highlighting

`useHighlightedCode(code, language)` returns one node per line. Both arguments can be refs or getters. The first render in the browser shows plain text. Server rendering waits for the colored lines. Shiki uses its JavaScript regex engine, so there is no WASM to load, and each language loads the first time it is used.

The supported languages are `bash`, `css`, `diff`, `html`, `javascript`, `json`, `jsx`, `markdown`, `python`, `sql`, `tsx`, `typescript`, `vue`, and `yaml`, with the aliases `js`, `ts`, `sh`, `shell`, `md`, and `yml`. Pass `"ansi"` to show the colors of terminal output. Other languages render as plain text. Tokens use the GitHub light and dark themes and follow the `dark` class of Nuxt UI.

## API reference

### CodeBlock

#### Props

| Prop      | Type                         | Default     | Description                                                      |
| --------- | ---------------------------- | ----------- | ---------------------------------------------------------------- |
| `variant` | `"default" \| "destructive"` | `"default"` | The tone of the block.                                           |
| `size`    | `"default" \| "sm"`          | `"default"` | `"sm"` has tighter padding and smaller code, for tool output.    |

### CodeBlockContent

| Prop          | Type      | Default | Description                                            |
| ------------- | --------- | ------- | ------------------------------------------------------ |
| `wrap`        | `boolean` | `false` | Wraps long lines instead of scrolling.                 |
| `lineNumbers` | `boolean` | `false` | Numbers each line. Plain text is split into lines.     |
| `startLine`   | `number`  | `1`     | The number of the first line.                          |

### CodeBlockLine

| Prop      | Type                                                  | Default     | Description                   |
| --------- | ----------------------------------------------------- | ----------- | ----------------------------- |
| `variant` | `"default" \| "added" \| "removed" \| "highlighted"` | `"default"` | Marks the line in a diff.     |

### CodeBlockCopyButton

| Prop    | Type     | Default  | Description        |
| ------- | -------- | -------- | ------------------ |
| `value` | `string` | Required | The text to copy.  |

A Nuxt UI `UButton` with `variant="ghost"` and `size="xs"`. Other attributes go to the button.

`CodeBlockHeader`, `CodeBlockTitle`, `CodeBlockActions`, and `CodeBlockFooter` have no props.

## Accessibility

- `CodeBlockContent` is focusable, so keyboard users can scroll long lines. The block shows a focus ring.
- `CodeBlockCopyButton` is labeled "Copy" and changes to "Copied". A polite live region announces the copy.
- Line numbers and diff markers are not selectable and are not read as text.

## Related

- [Code view](/docs/ui/code-view) shows a whole file with a file header.
- [Diff](/docs/ui/diff) shows file and patch diffs.
- [Trace](/docs/ui/trace) puts tool output under a step.
