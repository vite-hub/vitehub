---
title: Carets
description: "Style other people's carets and selections in a collaborative TipTap editor."
navigation.order: 33
navigation.group: Collaboration
icon: i-lucide-text-cursor
---

Carets show where other people type in a collaborative editor. TipTap's [CollaborationCaret](https://tiptap.dev/docs/editor/extensions/functionality/collaboration-caret) and Realtime's `RealtimeCaret` render the same markup without styles. `@vite-hub/ui/styles.css` styles it: a thin line in the person's color, with their name above it.

::example{name="CaretsExample" height=8}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows and load `@vite-hub/ui/styles.css`. There is no component. The styles apply to the editor's caret markup.

## Usage

Realtime adds carets to `realtime.extensions` by default:

```ts
import { useEditor } from "@tiptap/vue-3";
import { useRealtimeTiptap } from "vite-hub/realtime/vue";

const realtime = useRealtimeTiptap("docs", "guides/welcome.md");
const editor = useEditor({ extensions: realtime.extensions.value });
```

With TipTap's own Collaboration, add `CollaborationCaret` with the person's `name` and a `#RRGGBB` `color`.

## Features

- The line and label take the person's color from the extension's inline style.
- The label sits above the line and never wraps.
- Selections use `ProseMirror-yjs-selection`, which the extension tints in the person's color.
- Use the same colors in an [Avatar Stack](/docs/ui/avatar-stack) with `variant="outline"` so faces match carets.

## Accessibility

Carets are visual only. The label is small white text, so use colors with enough contrast against white. Override `.collaboration-carets__label` when a color is too light. Also show who is editing as text, such as in an Avatar Stack's `aria-label`.

## API Reference

### collaboration-carets__caret

A remote caret, a `span` in the text. Its `border-color` is the person's color.

### collaboration-carets__label

The name label inside the caret. Its `background-color` is the person's color.

### ProseMirror-yjs-selection

A remote selection. The extension sets its tinted background.

## Related

- [Avatar Stack](/docs/ui/avatar-stack) shows the same people.
- [Realtime](/docs/realtime/server-api#carets) explains the `carets` option, which changes the markup.
- [Collaborative Editor](/docs/ui/blocks/collaborative-editor) combines all collaboration parts with Realtime.
