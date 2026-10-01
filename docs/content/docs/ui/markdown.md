---
title: Markdown
description: "Render streaming assistant Markdown with chat typography, math, and image previews."
navigation.order: 13
navigation.group: Chat
icon: i-ph-markdown-logo-light
---

`AgentMarkdown` renders Markdown with `@comark/vue` and the `vh-typeset vh-typeset-chat` styles. Spacing comes from the start of each block, so the layout stays stable while streamed text appends new nodes. Use it for assistant text, or anywhere you show Markdown from a model.

::component-preview{name="MarkdownExample"}
::

## Usage

```vue
<AgentMarkdown :value="part.text" :streaming="part.state === 'streaming'" />
```

## Examples

### Streaming

Set `streaming` while text arrives. A formula without its closing delimiter stays text until the delimiter arrives.

::component-preview{name="MarkdownStreamingExample" reset}
::

### Math

KaTeX renders math by default. Use `$...$` or `\(...\)` for inline formulas and `$$...$$` or `\[...\]` for display formulas.

::component-preview{name="MarkdownMathExample"}
::

- Start a display formula at the beginning of a line. Its closing delimiter must end the line.
- For dollar-delimited inline math, do not put spaces directly inside the delimiters.
- Math inside code spans and fenced code blocks stays literal.
- If KaTeX rejects a formula, its source renders as code.

### Images

Images render as compact thumbnails. Select one to open it at its full aspect ratio. Press Escape or select the close button to return. The dialog also links to the original image.

::component-preview{name="MarkdownImageExample"}
::

## Custom components

Pass Comark components to replace an element or add a custom one. Set `components.img` to replace the image preview, or `components.math` to replace KaTeX. A math component receives the formula as `content` and a `class` that contains `block` for display math.

```vue
<AgentMarkdown
  :value="answer"
  :components="{ Callout: MyCallout, math: MyMath }"
  :options="{ gfm: true }"
/>
```

Comark 0.7 takes parser plugins in the top-level `plugins` prop. `options` holds parser settings only. ViteHub always sets `options.html` to `false`.

## Styling

Override the typography variables on one instance or globally. The base rules style prose rhythm, headings, lists, links, inline code, code blocks, and blockquotes. They do not style application chrome.

```css
.support-answer {
  --vh-typeset-flow: 1em;
  --vh-typeset-leading: 1.7;
}
```

Change the default class for every instance with the `markdown.class` [default](/docs/ui/installation#defaults).

## API reference

### AgentMarkdown

#### Props

| Prop         | Type                          | Default | Description                                                         |
| ------------ | ----------------------------- | ------- | ------------------------------------------------------------------- |
| `value`      | `string`                      | `''`    | The Markdown source.                                                |
| `streaming`  | `boolean`                     | `false` | Parses the value as partial, streamed Markdown.                     |
| `components` | `MarkdownProps['components']` |         | Comark components. Merged over the built-in `img` and `math` components. |
| `options`    | `MarkdownProps['options']`    |         | Comark parser options. `html` is always `false`.                    |
| `plugins`    | `MarkdownProps['plugins']`    |         | Comark parser plugins. Added after the built-in math plugin.        |

Other attributes, for example `class`, go to the Comark root.

## Accessibility

- Raw HTML in the source does not render. KaTeX runs with trusted commands disabled.
- Image thumbnails are buttons. The expanded view closes with Escape and returns focus.
- Write meaningful image alt text in the Markdown source. It becomes the button and dialog label.

## Related

- [Message parts](/docs/ui/message-parts) uses `AgentMarkdown` for text parts.
- [Installation](/docs/ui/installation#defaults) sets the default Markdown class.
