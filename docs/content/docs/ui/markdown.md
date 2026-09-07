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
