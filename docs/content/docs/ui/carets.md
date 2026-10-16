---
title: Carets
description: "Style other people's carets and selections in a collaborative TipTap editor."
navigation.order: 29
navigation.group: Collaboration
icon: i-ph-cursor-text-light
---

Carets show where other people type in a collaborative editor. TipTap's [CollaborationCaret](https://tiptap.dev/docs/editor/extensions/functionality/collaboration-caret) and Realtime's `RealtimeCaret` render the same markup but ship no styles. `@vite-hub/ui/styles.css` styles that markup: a thin line in the person's color, with their name in a label above it.

::component-preview{name="CaretsExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation) and load `@vite-hub/ui/styles.css`. There is no component to import: the styles apply to the editor's caret markup.

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

- The line and the label take the person's color from the inline style that the extension sets.
- The label sits above the line and never wraps.
- Selections use `ProseMirror-yjs-selection`, tinted in the person's color by the extension.
- Use the same colors in an [Avatar Stack](/docs/ui/avatar-stack) with `variant="outline"`, so each face matches its caret.

## API reference

### collaboration-carets__caret

The class of a remote caret, a `span` in the text. Its `border-color` is the person's color.

### collaboration-carets__label

The class of the name label inside the caret. Its `background-color` is the person's color.

### ProseMirror-yjs-selection

The class of a remote selection. The extension sets its tinted background.

## Accessibility

Carets are visual only. The label is small white text, so use presence colors that keep enough contrast with white, and override `.collaboration-carets__label` when a color is too light. Keep who is editing available as text elsewhere, for example in the `aria-label` of an Avatar Stack.

## Related

- [Avatar Stack](/docs/ui/avatar-stack) shows the same people.
- [Realtime](/docs/realtime/server-api) explains `carets` and `RealtimeCaret`.
