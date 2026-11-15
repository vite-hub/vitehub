---
title: Bubble
description: "Frame message text in one of seven Bubble variants, align it to a side, group Bubbles, and attach reactions."
navigation.order: 11
navigation.group: Parts
icon: i-lucide-message-circle
---

`Bubble` frames the text of a turn. Seven variants cover the current user, the assistant, quiet notes, and errors. The parts match the names, props, and `data-slot` attributes of the [shadcn/ui Bubble](https://ui.shadcn.com/docs/components/bubble). Colors come from your app's Nuxt UI tokens.

`Bubble` is only the frame. Put avatars, names, timestamps, and message actions in [Message](/docs/ui/message).

::example{name="BubbleExample" height=26}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui`:

```ts
import { Bubble, BubbleContent, BubbleGroup, BubbleReactions } from "@vite-hub/ui";
```

## Usage

```ts
import { Bubble, BubbleContent, BubbleReactions } from "@vite-hub/ui";
```

```vue
<template>
  <Bubble>
    <BubbleContent>I checked the build output and removed the stale route.</BubbleContent>
    <BubbleReactions role="img" aria-label="Reaction: thumbs up">
      <span>👍</span>
    </BubbleReactions>
  </Bubble>
</template>
```

## Composition

```text
Bubble
├── BubbleContent
└── BubbleReactions
```

`BubbleGroup` groups consecutive bubbles from one sender:

```text
BubbleGroup
├── Bubble
│   └── BubbleContent
└── Bubble
    └── BubbleContent
```

## Features

- Seven variants, from a strong primary bubble to unframed ghost content.
- Start and end alignment for sender and receiver.
- Reactions on the top or bottom edge, at the start or end.
- A bubble fits its content, up to 80% of the container width.
- `as` on `BubbleContent` renders a link or button with hover and focus styles.
- Default styles sit in the `components` layer of `@vite-hub/ui/styles.css`, so a utility class such as `class="max-w-lg"` overrides them.

## Variants

Use `variant` to change the look.

::example{name="BubbleVariantsExample" height=48}
::

| Variant       | Use for                                       |
| ------------- | --------------------------------------------- |
| `default`     | The current user. Uses the primary color.     |
| `secondary`   | Normal conversation content. |
| `muted`       | Quiet supporting content.                     |
| `tinted`      | A subtle primary tint.                        |
| `outline`     | Secondary or rich content, with a border. |
| `ghost`       | Unframed assistant text or rich content.      |
| `destructive` | Errors and failed actions.                    |

`ghost` removes the maximum width, so assistant text and rich content can use the full row.

## Alignment

Set `align` on `Bubble` to place it at the start or end of the conversation.

::example{name="BubbleAlignmentExample" height=10}
::

| Align   | Description                                        |
| ------- | -------------------------------------------------- |
| `start` | The start of the conversation. |
| `end`   | The end of the conversation. |

In a chat, set `align` on [Message](/docs/ui/message) instead. A bubble in a `Message` with `align="end"` aligns to the end.

## Bubble Group

Group consecutive bubbles from one sender. Set `align` on each `Bubble`, not on the group.

::example{name="BubbleGroupExample" height=22}
::

## Links and Buttons

Set `as` on `BubbleContent` to render another element or component, with hover and focus styles.

::example{name="BubbleLinksExample" height=14}
::

```vue
<BubbleContent as="a" href="/runs/42">Open run 42</BubbleContent>
<BubbleContent :as="NuxtLink" to="/runs/42">Open run 42</BubbleContent>
<BubbleContent as="button" type="button" @click="retry">Retry the deploy</BubbleContent>
```

## Reactions

Use `BubbleReactions` for reactions or quick actions. Place the row with `side` and `align`. `side="top"` puts it on the upper edge. Reactions overlap the bubble edge, so leave vertical space between rows, as the larger `gap` in the examples does.

::example{name="BubbleReactionsExample" height=25}
::

## Show More

Put a toggle in `BubbleContent` to show more or less of a long message. The button sets `aria-expanded` and `aria-controls`.

::example{name="BubbleCollapsibleExample" height=20}
::

## Tooltip

Put a `UTooltip` in `BubbleReactions` to show details on hover, such as when the message was read.

::example{name="BubbleTooltipExample" height=9}
::

## Popover

Put a `UPopover` in `BubbleReactions` to show more on demand, such as the full error of a failed action.

::example{name="BubblePopoverExample" height=9}
::

## Accessibility

`Bubble` is only the visual surface. Keep conversation semantics on the container, such as `role="log"` as [Chat](/docs/ui/chat) does.

### Labeling Reactions

A screen reader reads each emoji with no context, and `+8` as "plus eight". Give the row `role="img"` and an `aria-label`, so it is read once. `role="img"` also hides each emoji from assistive technology.

```vue
<BubbleReactions role="img" aria-label="Reactions: thumbs up, fire, and 8 more">
  <span>👍</span>
  <span>🔥</span>
  <span>+8</span>
</BubbleReactions>
```

For interactive reactions, use buttons. Give icon-only buttons an `aria-label`.

```vue
<BubbleReactions>
  <UButton color="neutral" variant="ghost" size="xs" square icon="i-lucide-thumbs-up" aria-label="Thumbs up" />
</BubbleReactions>
```

### Interactive Bubbles

For a clickable bubble, set `as="button"` or `as="a"` on `BubbleContent`. It is then focusable, has the correct role, and shows a focus ring. Its text is the accessible name.

```vue
<BubbleContent as="button" type="button" @click="reply">I forgot my password</BubbleContent>
```

### Meaning Beyond Color

Variants show role and tone with color. Do not use color alone. In a `destructive` bubble, say "Failed" in the text.

## API Reference

### Bubble

Renders a `div` with `data-slot="bubble"`.

#### Props

| Prop      | Type                                                                                       | Default     | Description                         |
| --------- | ------------------------------------------------------------------------------------------ | ----------- | ----------------------------------- |
| `variant` | `"default" \| "secondary" \| "muted" \| "tinted" \| "outline" \| "ghost" \| "destructive"` | `"default"` | The look of the bubble. |
| `align`   | `"start" \| "end"`                                                                         | `"start"`   | Inline alignment. |

### BubbleContent

The framed content. Renders `data-slot="bubble-content"` on the element that `as` selects.

#### Props

| Prop | Type                  | Default | Description                                                |
| ---- | --------------------- | ------- | ---------------------------------------------------------- |
| `as` | `string \| Component` | `"div"` | Renders another element, such as a link. |

### BubbleReactions

A reaction row that overlaps the bubble edge. Renders a `div` with `data-slot="bubble-reactions"`.

#### Props

| Prop    | Type                | Default    | Description                                      |
| ------- | ------------------- | ---------- | ------------------------------------------------ |
| `side`  | `"top" \| "bottom"` | `"bottom"` | The bubble edge for the reactions. |
| `align` | `"start" \| "end"`  | `"end"`    | Inline alignment of the reactions. |

### BubbleGroup

Groups consecutive bubbles from one sender. No props. Renders a `div` with `data-slot="bubble-group"`.

## Related

- [Message](/docs/ui/message) aligns the bubble in a turn.
- [Marker](/docs/ui/marker) shows status and separators between turns.
