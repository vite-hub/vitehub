---
title: Markdown
description: "Render Content pages and streaming Markdown with Comark UI components, typography, math, and image previews."
navigation.order: 23
navigation.group: Chat
icon: i-ph-markdown-logo-light
---

`Markdown` renders Markdown strings and parsed Content pages with Comark UI components and document styles already configured. Use it for authored pages and assistant text. Streaming strings also use the `vh-typeset vh-typeset-chat` styles. Spacing comes from the start of each block, so the layout stays stable while streamed text appends new nodes.

::component-preview{name="MarkdownExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/markdown`:

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

Pass a Content page directly. ViteHub uses its pre-parsed nodes without parsing them again. Callouts, tabs, steps, badges, cards, and document typography use the bundled Comark UI renderers.

```vue
<script setup lang="ts">
import { Markdown } from "vite-hub/ui/markdown";

const { data: page } = await useFetch("/api/content/get/docs/introduction");
</script>

<template>
  <Markdown v-if="page" :value="page" />
</template>
```

There is no separate Comark install, preset, component map, or stylesheet. `components` is an optional override. A parsed page keeps the document's parser settings; `plugins` and `options` apply only to string values.

## Composition

`Markdown` chooses the string parser or document renderer from the value. Comark UI supplies the block components. Images use ViteHub previews; string formulas use lazy KaTeX. Replace individual renderers with the `components` prop.

## Features

- Renders parsed Content pages with the bundled Comark UI components.
- Parses partial Markdown while text streams.
- Keeps the layout stable while streamed text appends new nodes.
- Renders string formulas with lazy KaTeX and preserves pre-rendered math in Content pages.
- Shows images as thumbnails that open a full preview.
- Accepts Comark components, parser options, and plugins.
- Raw HTML in string values stays disabled. Parsed Content pages render their existing nodes.

## Streaming

Set `streaming` while text arrives. A formula without its closing delimiter stays text until the delimiter arrives.

::component-preview{name="MarkdownStreamingExample" reset}
::

## Math

For string values, `Markdown` loads KaTeX with the first formula. Use `$...$` or `\(...\)` for inline formulas and `$$...$$` or `\[...\]` for display formulas.

::component-preview{name="MarkdownMathExample"}
::

- Start a display formula at the beginning of a line. Its closing delimiter must end the line.
- For dollar-delimited inline math, do not put spaces directly inside the delimiters.
- Math inside code spans and fenced code blocks stays literal.
- If KaTeX rejects a formula, its source renders as code.

Parsed Content pages keep the math nodes produced by their parser, including pre-rendered MathML. They do not load the string parser's KaTeX renderer.

## Images

Images render as compact thumbnails. Select one to open it at its full aspect ratio. Press Escape or select the close button to return. The dialog also links to the original image.

::component-preview{name="MarkdownImageExample"}
::

## Custom components

Pass Comark components to replace an element or add a custom one. Set `components.img` to replace the image preview. For string values, `components.math` replaces KaTeX and receives the formula as `content` and a `class` that contains `block` for display math.

```vue
<Markdown
  :value="answer"
  :components="{ Callout: MyCallout, math: MyMath }"
  :options="{ gfm: true }"
/>
```

Comark takes parser plugins in the top-level `plugins` prop. `options` holds parser settings only. Raw HTML stays disabled for string values.

## Styling

Override the typography variables on one instance or globally. The base rules style prose rhythm, headings, lists, links, inline code, code blocks, and blockquotes. They do not style application chrome.

```css
.support-answer {
  --vh-typeset-flow: 1em;
  --vh-typeset-leading: 1.7;
}
```

Change the default class for every instance with the `markdown.class` [default](/docs/ui/installation#defaults).

## Accessibility

- Raw HTML in string values does not render. Parsed pages use their existing nodes and parser settings.
- KaTeX runs with trusted commands disabled for string formulas.
- Image thumbnails are buttons. The expanded view closes with Escape and returns focus.
- Write meaningful image alt text in the Markdown source. It becomes the button and dialog label.

## API Reference

### Markdown

Renders a Markdown string or a parsed Content page as styled prose. The focused `vite-hub/ui/markdown` and `@vite-hub/ui/markdown` entries also export the `MarkdownValue` type.

#### Props

| Prop         | Type                          | Default | Description |
| ------------ | ----------------------------- | ------- | ----------- |
| `value`      | `MarkdownValue`               | `""`    | Markdown string or a parsed Content page with `nodes`. |
| `streaming`  | `boolean`                     | `false` | Treats string values as partial, streamed Markdown. |
| `components` | `MarkdownProps['components']` |         | Optional overrides for the bundled Comark UI components. |
| `options`    | `MarkdownProps['options']`    |         | Parser options for string values. Raw HTML stays disabled. |
| `plugins`    | `MarkdownProps['plugins']`    |         | Parser plugins for string values. Extend or replace defaults by name. |

Other attributes, for example `class`, go to the Comark root.

## Related

- [Message parts](/docs/ui/message-parts) uses `Markdown` for text parts.
- [Installation](/docs/ui/installation#defaults) sets the default Markdown class.
