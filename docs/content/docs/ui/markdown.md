---
title: Markdown
description: "Render Content pages and streaming Markdown with Comark UI components, typography, math, and image previews."
navigation.order: 23
navigation.group: Chat
icon: i-ph-markdown-logo-light
---

`Markdown` renders Markdown strings and parsed Content pages with Comark UI components and document styles already configured. Streaming strings also use the `vh-typeset vh-typeset-chat` styles. Spacing comes from the start of each block, so the layout stays stable while streamed text appends new nodes. Use it for assistant text, or anywhere you show Markdown from a model.

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

```text
Markdown (Comark root, vh-typeset vh-typeset-chat)
├── img: image preview, or components.img
└── math: KaTeX, or components.math
```

## Features

- Parses partial Markdown while text streams.
- Keeps the layout stable while streamed text appends new nodes.
- Renders math with KaTeX.
- Shows images as thumbnails that open a full preview.
- Accepts Comark components, parser options, and plugins.
- Raw HTML in string values stays disabled. Parsed Content pages render their existing nodes.

## Streaming

Set `streaming` while text arrives. A formula without its closing delimiter stays text until the delimiter arrives.

::component-preview{name="MarkdownStreamingExample" reset}
::

## Math

KaTeX renders math by default. Use `$...$` or `\(...\)` for inline formulas and `$$...$$` or `\[...\]` for display formulas.

::component-preview{name="MarkdownMathExample"}
::

- Start a display formula at the beginning of a line. Its closing delimiter must end the line.
- For dollar-delimited inline math, do not put spaces directly inside the delimiters.
- Math inside code spans and fenced code blocks stays literal.
- If KaTeX rejects a formula, its source renders as code.

## Images

Images render as compact thumbnails. Select one to open it at its full aspect ratio. Press Escape or select the close button to return. The dialog also links to the original image.

::component-preview{name="MarkdownImageExample"}
::

## Custom Components

Pass Comark components to replace an element or add a custom one. Set `components.img` to replace the image preview, or `components.math` to replace KaTeX. A math component receives the formula as `content` and a `class` that contains `block` for display math.

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

- Raw HTML in the source does not render. KaTeX runs with trusted commands disabled.
- Image thumbnails are buttons. The expanded view closes with Escape and returns focus.
- Write meaningful image alt text in the Markdown source. It becomes the button and dialog label.

## API Reference

### Markdown

Renders the Markdown source as styled prose.

#### Props

| Prop         | Type                          | Default | Description                                                         |
| ------------ | ----------------------------- | ------- | ------------------------------------------------------------------- |
| `value`      | `string \| { nodes: Node[] }` | `""` | Markdown source or a parsed Content page.                                                |
| `streaming`  | `boolean`                     | `false` | Parses the value as partial, streamed Markdown.                     |
| `components` | `MarkdownProps['components']` |         | Comark components. Optional overrides for the bundled components. |
| `options`    | `MarkdownProps['options']`    |         | Comark parser options. `html` is always `false`.                    |
| `plugins`    | `MarkdownProps['plugins']`    |         | Comark parser plugins. Extend or replace the string parser defaults by name.        |

Other attributes, for example `class`, go to the Comark root.

## Related

- [Message parts](/docs/ui/message-parts) uses `Markdown` for text parts.
- [Installation](/docs/ui/installation#defaults) sets the default Markdown class.
