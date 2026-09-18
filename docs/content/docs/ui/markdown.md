---
title: Markdown
description: Render streaming assistant Markdown with compact chat typography.
navigation.order: 13
navigation.group: Chat
icon: i-ph-markdown-logo-light
---

`AgentMarkdown` wraps `@comark/vue` and applies the `vh-typeset vh-typeset-chat` defaults. The stylesheet uses block-start spacing, which remains stable while streaming content appends new nodes.

Images render as compact thumbnails. Select an image to view it at full aspect ratio in a dark overlay. Press Escape or select Close to return to the message. Set `components.img` to replace this preview.

::component-preview{name="MarkdownExample"}
::

```vue
<AgentMarkdown :value="part.text" :streaming="part.state === 'streaming'" />
```

## Math

`AgentMarkdown` renders math with KaTeX by default. Use `$...$` or `\(...\)` for inline formulas, and `$$...$$` or `\[...\]` for display formulas. Start a display formula at the beginning of a line; its closing delimiter must end the line. For example, this Markdown renders an inline exponent and a display equation:

```md
The squared distance is $r^2$.

$$
r = \sqrt{x^2 + y^2}
$$
```

For dollar-delimited inline math, omit spaces immediately inside the delimiters. Math inside code spans and fenced code blocks stays literal. Incomplete formulas remain text while streaming until their closing delimiter arrives. If KaTeX rejects a formula, its content renders as readable code instead. The renderer disables trusted HTML and unsafe links.

Set `components.math` to replace the built-in renderer. Your component receives the formula as `content` and a `class` containing `block` for display math:

```vue
<AgentMarkdown :value="answer" :components="{ math: MyMath }" />
```

## Custom components

Pass Comark components and parser options directly:

```vue
<AgentMarkdown :value="answer" :components="{ Callout: MyCallout }" :options="{ gfm: true }" />
```

## Styling

Override the package defaults globally or add a class per instance. The base rules deliberately avoid styling application chrome; they cover prose rhythm, headings, lists, links, inline code, code blocks, and blockquotes.

```css
.support-answer {
  --vh-typeset-flow: 1em;
  --vh-typeset-leading: 1.7;
}
```

Comark 0.7 uses the top-level `plugins` prop for parser plugins. Move `options.plugins` to `plugins`; `options` contains parser settings only. `AgentMarkdown` continues to accept `streaming` as a top-level boolean prop.
