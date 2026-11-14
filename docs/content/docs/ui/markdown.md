---
title: Markdown
description: "Render Content pages and streaming Markdown with Comark UI components, typography, math, and image previews."
navigation.order: 23
navigation.group: Chat
icon: i-lucide-file-text
---

`Markdown` renders Markdown strings and parsed Content pages, with Comark UI components and document styles set up. Use it for written pages and assistant text. Streaming strings also use the `vh-typeset vh-typeset-chat` styles. Spacing comes from the start of each block, so the layout stays still while streamed text adds nodes.

::example{name="MarkdownExample" height=8}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui`:

```ts
import { Markdown } from "@vite-hub/ui";
```

## Usage

```ts
import { Markdown } from "@vite-hub/ui";
```

```vue
<Markdown :value="part.text" :streaming="part.state === 'streaming'" />
```

## Content pages

Pass a Content page directly. ViteHub uses its parsed nodes as they are. Callouts, tabs, steps, badges, cards, and typography use the bundled Comark UI renderers.

```vue
<script setup lang="ts">
import { Markdown } from "vite-hub/ui";

const { data: page } = await useFetch("/api/content/get/docs/introduction");
</script>

<template>
  <Markdown v-if="page" :value="page" />
</template>
```

You need no separate Comark install, preset, component map, or stylesheet. `components` is an optional override. A parsed page keeps its parser settings. `plugins` and `options` apply only to strings.

## Composition

`Markdown` picks the string parser or the document renderer from the value. Comark UI gives the block components. Images use ViteHub previews. String formulas use lazy-loaded KaTeX. Replace single renderers with the `components` prop.

## Features

- Parses partial Markdown while text streams.
- Renders string formulas with lazy KaTeX and keeps pre-rendered math in Content pages.
- Shows images as thumbnails that open a full preview.
- Takes Comark components, parser options, and plugins.
- Raw HTML in strings stays off. Parsed Content pages render their existing nodes.

## Streaming

Set `streaming` while text arrives. A formula stays text until its closing delimiter arrives.

::example{name="MarkdownStreamingExample" reset height=22}
::

## Math

For strings, `Markdown` loads KaTeX with the first formula. Use `$...$` or `\(...\)` for inline formulas and `$$...$$` or `\[...\]` for display formulas.

::example{name="MarkdownMathExample" height=14}
::

- Start a display formula at the start of a line. Its closing delimiter must end the line.
- In `$` inline math, put no spaces directly inside the delimiters.
- Math in code spans and code blocks stays as text.
- If KaTeX rejects a formula, its source renders as code.

Parsed Content pages keep their parser's math nodes, including pre-rendered MathML. They do not load KaTeX.

## Images

Images show as small thumbnails. Select one to open it at full aspect ratio. Press Escape or the close button to return. The dialog also links to the original image.

::example{name="MarkdownImageExample" height=24}
::

## Custom components

Pass Comark components to replace an element or add one. `components.img` replaces the image preview. For strings, `components.math` replaces KaTeX. It receives the formula as `content`, and a `class` with `block` for display math.

```vue
<Markdown
  :value="answer"
  :components="{ Callout: MyCallout, math: MyMath }"
  :options="{ gfm: true }"
/>
```

Parser plugins go in the top-level `plugins` prop. `options` holds parser settings only. Raw HTML stays off for strings. A plugin named `html` in `plugins` throws `UI_R0002`.

## Styling

Override the typography variables on one instance or globally. The base rules style spacing, headings, lists, links, inline code, code blocks, and blockquotes, not app chrome.

```css
.support-answer {
  --vh-typeset-flow: 1em;
  --vh-typeset-leading: 1.7;
}
```

Change the class of every instance with the `markdown.class` [default](/docs/ui/installation#defaults).

## Accessibility

- Raw HTML in strings does not render. Parsed pages use their existing nodes and parser settings.
- KaTeX runs with trusted commands off for string formulas.
- Image thumbnails are buttons. The expanded view closes with Escape and returns focus.
- Write useful image alt text. It becomes the button and dialog label.

## API Reference

### Markdown

Renders a Markdown string or parsed Content page as styled prose. The `vite-hub/ui` and `@vite-hub/ui` entries also export the `MarkdownValue` type.

#### Props

| Prop         | Type                          | Default | Description |
| ------------ | ----------------------------- | ------- | ----------- |
| `value`      | `MarkdownValue`               | `""`    | A Markdown string or a parsed Content page with `nodes`. |
| `streaming`  | `boolean`                     | `false` | Treats strings as partial, streamed Markdown. |
| `components` | `MarkdownProps['components']` |         | Overrides for the bundled Comark UI components. |
| `options`    | `MarkdownProps['options']`    |         | Parser options for strings. Raw HTML stays off. |
| `plugins`    | `MarkdownProps['plugins']`    |         | Parser plugins for strings. Extend or replace defaults by name. |

Other attributes, such as `class`, go to the Comark root.

## Related

- [Message parts](/docs/ui/message-parts) uses `Markdown` for text parts.
- [Installation](/docs/ui/installation#defaults) sets the default Markdown class.
