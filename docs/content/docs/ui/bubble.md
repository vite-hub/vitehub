---
title: Bubble
description: "Frame message text in one of seven variants and attach reactions."
navigation.order: 11
navigation.group: Parts
icon: i-ph-chat-circle-light
---

`Bubble` frames the text of a turn. Seven variants cover the current user, the assistant, quiet notes, and errors. The parts have the same names, props, and `data-slot` attributes as the [shadcn/ui Bubble](https://ui.shadcn.com/docs/components/bubble). Colors come from the Nuxt UI tokens of your app.

`Bubble` is only the framed surface. Put avatars, names, timestamps, and message actions in [Message](/docs/ui/message).

::component-preview{name="BubbleExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/bubble`:

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

Use `BubbleGroup` to group consecutive bubbles from the same sender:

```text
BubbleGroup
├── Bubble
│   └── BubbleContent
└── Bubble
    └── BubbleContent
```

## Features

- Seven variants, from a strong primary bubble to unframed ghost content.
- Start and end alignment for the sender and the receiver.
- Reactions on the top or bottom edge of the bubble, at the start or the end.
- A bubble sizes to its content, up to 80% of the container width.
- `as` on `BubbleContent` renders a link or a button with hover and focus styles.
- The default styles are in the `components` layer of `@vite-hub/ui/styles.css`, so a utility class such as `class="max-w-lg"` overrides them.

## Variants

Use `variant` to change the visual treatment of the bubble.

::component-preview{name="BubbleVariantsExample"}
::

| Variant       | Use for                                       |
| ------------- | --------------------------------------------- |
| `default`     | The current user. Uses the primary color.     |
| `secondary`   | Standard conversation content.                |
| `muted`       | Quiet supporting content.                     |
| `tinted`      | A subtle primary tint.                        |
| `outline`     | Secondary or rich content with a border.      |
| `ghost`       | Unframed assistant text or rich content.      |
| `destructive` | Errors and failed actions.                    |

The `ghost` variant removes the maximum width, so assistant text and rich content can use the full row.

## Alignment

Use `align` on `Bubble` to align the bubble to the start or the end of the conversation.

::component-preview{name="BubbleAlignmentExample"}
::

| Align   | Description                                        |
| ------- | -------------------------------------------------- |
| `start` | Aligns the bubble to the start of the conversation. |
| `end`   | Aligns the bubble to the end of the conversation.   |

In a chat, set `align` on [Message](/docs/ui/message) instead. A bubble in a `Message` with `align="end"` aligns to the end.

## Bubble Group

Use `BubbleGroup` to group consecutive bubbles from the same sender. Set `align` on each `Bubble`, not on the group.

::component-preview{name="BubbleGroupExample"}
::

## Links and Buttons

Set `as` on `BubbleContent` to render it as another element or component. The bubble then gets hover and focus styles.

::component-preview{name="BubbleLinksExample"}
::

```vue
<BubbleContent as="a" href="/runs/42">Open run 42</BubbleContent>
<BubbleContent :as="NuxtLink" to="/runs/42">Open run 42</BubbleContent>
<BubbleContent as="button" type="button" @click="retry">Retry the deploy</BubbleContent>
```

## Reactions

Use `BubbleReactions` for reactions or quick actions. Use `side` and `align` to place the row. `side="top"` puts it on the upper edge. Reactions overlap the edge of the bubble, so leave vertical space between rows. The examples use a larger `gap` for this reason.

::component-preview{name="BubbleReactionsExample"}
::

## Show More

Put a toggle in `BubbleContent` to show more or less of a long message. The button sets `aria-expanded` and `aria-controls`.

::component-preview{name="BubbleCollapsibleExample"}
::

## Tooltip

Put a `UTooltip` in `BubbleReactions` to show metadata on hover, such as when the reader read the message.

::component-preview{name="BubbleTooltipExample"}
::

## Popover

Put a `UPopover` in `BubbleReactions` to show more information on demand, such as the full error of a failed action.

::component-preview{name="BubblePopoverExample"}
::

## Accessibility

`Bubble` renders the visual surface of a message. Keep the conversation semantics on the container around it, for example `role="log"` as [Chat](/docs/ui/chat) does.

### Labeling Reactions

A screen reader reads each emoji with no context, and it reads a counter such as `+8` as "plus eight". Give the row `role="img"` and an `aria-label`, so it is read once. `role="img"` also hides each emoji from assistive technology.

```vue
<BubbleReactions role="img" aria-label="Reactions: thumbs up, fire, and 8 more">
  <span>👍</span>
  <span>🔥</span>
  <span>+8</span>
</BubbleReactions>
```

When reactions are interactive, use buttons. Give an icon-only button an `aria-label`.

```vue
<BubbleReactions>
  <UButton color="neutral" variant="ghost" size="xs" square icon="i-ph-thumbs-up-light" aria-label="Thumbs up" />
</BubbleReactions>
```

### Interactive Bubbles

When a bubble is clickable, set `as="button"` or `as="a"` on `BubbleContent`. The bubble is then focusable, has the correct role, and shows a focus ring. The bubble text is the accessible name.

```vue
<BubbleContent as="button" type="button" @click="reply">I forgot my password</BubbleContent>
```

### Meaning Beyond Color

Variants show role and tone with color. Do not use color as the only signal. In a `destructive` bubble, say "Failed" in the text.

## API Reference

### Bubble

The root of a bubble. Renders a `div` with `data-slot="bubble"`.

#### Props

| Prop      | Type                                                                                       | Default     | Description                         |
| --------- | ------------------------------------------------------------------------------------------ | ----------- | ----------------------------------- |
| `variant` | `"default" \| "secondary" \| "muted" \| "tinted" \| "outline" \| "ghost" \| "destructive"` | `"default"` | The visual treatment of the bubble. |
| `align`   | `"start" \| "end"`                                                                         | `"start"`   | The inline alignment of the bubble. |

### BubbleContent

The framed content of the bubble. Renders `data-slot="bubble-content"` on the element that `as` selects.

#### Props

| Prop | Type                  | Default | Description                                                |
| ---- | --------------------- | ------- | ---------------------------------------------------------- |
| `as` | `string \| Component` | `"div"` | Renders the content as another element, such as a link.    |

### BubbleReactions

A row of reactions that overlaps the edge of the bubble. Renders a `div` with `data-slot="bubble-reactions"`.

#### Props

| Prop    | Type                | Default    | Description                                      |
| ------- | ------------------- | ---------- | ------------------------------------------------ |
| `side`  | `"top" \| "bottom"` | `"bottom"` | The side of the bubble that holds the reactions. |
| `align` | `"start" \| "end"`  | `"end"`    | The inline alignment of the reactions.           |

### BubbleGroup

Groups consecutive bubbles from the same sender. Has no props. Renders a `div` with `data-slot="bubble-group"`.

## Related

- [Message](/docs/ui/message) aligns the bubble in a turn.
- [Marker](/docs/ui/marker) shows status and separators between turns.
