---
title: Message Scroller
description: "Compose headless message scrolling with live-edge following, prepend preservation, and message jumps."
navigation.order: 41
navigation.group: Utilities
icon: i-lucide-scroll-text
---

The message scroller is the scrolling layer under `Chat`. It follows new content only while the reader is at the bottom (the live edge), keeps the position when older messages load above, and jumps to a message ID. The parts match the names and `data-slot` attributes of the [shadcn/ui Message Scroller](https://ui.shadcn.com/docs/components/message-scroller).

The scroller does not hold messages, Agent state, transport, or storage. Put any row in it: a message, marker, log line, or "load earlier" row.

::example{name="MessageScrollerExample" height=20}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. The parts are headless (unstyled). Import them from `@vite-hub/ui/headless`, which loads no styles and needs no Nuxt UI. `vite-hub/nuxt` does not auto-import them:

```ts
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "@vite-hub/ui/headless";
```

`@vite-hub/ui/styles.css` adds the shadcn/ui layout: a full-height root, a thin-scrollbar viewport, `1.5rem` between items, and a centered bottom button. Load it after Tailwind CSS and Nuxt UI, as [Installation](/docs/ui/installation) shows.

## Usage

```ts
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "@vite-hub/ui/headless";
```

```vue
<template>
  <MessageScroller>
    <MessageScrollerViewport>
      <MessageScrollerContent :items="messages.map((message) => message.id)">
        <MessageScrollerItem
          v-for="message in messages"
          :key="message.id"
          :message-id="message.id"
          :scroll-anchor="message.role === 'user'"
        >
          <Message />
        </MessageScrollerItem>
      </MessageScrollerContent>
    </MessageScrollerViewport>
    <MessageScrollerButton />
  </MessageScroller>
</template>
```

`MessageScroller` fills its parent, so give the parent a fixed height.

```vue
<template>
  <div class="flex h-screen flex-col">
    <MessageScroller class="min-h-0 flex-1">
      <!-- transcript -->
    </MessageScroller>
  </div>
</template>
```

## Composition

```text
MessageScroller
├── MessageScrollerViewport
│   └── MessageScrollerContent
│       └── MessageScrollerItem
│           └── a message, marker, or row
└── MessageScrollerButton
```

- `MessageScroller` is the root. It holds the scroll state and behavior props.
- `MessageScrollerViewport` scrolls. It reads wheel, pointer, and keyboard input to stop following.
- `MessageScrollerContent` holds the rows. Its `items` prop tells the scroller when rows are added at the top.
- `MessageScrollerItem` wraps each direct child of the content, so the scroller can anchor and jump to it.
- `MessageScrollerButton` scrolls to the latest message. It is hidden and inert at the live edge.

## Features

- Follows new content only at the live edge.
- Stops following when the reader scrolls up with wheel, pointer, or keyboard.
- Moves a new turn near the top with `scrollAnchor`, with part of the previous item visible.
- Keeps visible content in place when older messages load above.
- Jumps to any item by ID with `scrollToMessage()`.
- Exposes `atEnd` and `isScrollable` through the root slot and `useMessageScroller()`.
- Has no styles. `@vite-hub/ui/styles.css` adds the shadcn/ui layout.

## Anchoring Turns

A turn is one exchange, usually a user message and its reply. Set `scrollAnchor` on the row that starts the turn. When it mounts, the viewport moves it near the top and stops following, so the reply grows below it.

Any row can be an anchor: a user message, an assistant reply, or a marker. Select **User** or **Assistant** below, then send a message.

::example{name="MessageScrollerAnchorExample" reset height=30}
::

The anchor moves up only as far as the content allows. Give the content bottom padding, as `Chat` does, so a new turn can reach the top.

## Keeping Context Visible

`previousItemPeek` keeps part of the previous item visible above a new anchor, so the reader sees where the turn connects.

```vue
<template>
  <!-- Keep 64px of the previous turn visible above the anchored row. -->
  <MessageScroller :previous-item-peek="64">
    <!-- anchored turns -->
  </MessageScroller>
</template>
```

## Following the Live Edge

At the end, `autoScroll` keeps new content in view. It reacts to new rows, growing text, and size changes. The reader stops following with the wheel, a scrollbar drag, or `ArrowUp`, `Home`, `PageUp`, and `Shift+Space`. New lines then arrive without moving the view. `MessageScrollerButton` returns to the end and follows again.

`edgeThreshold` sets how many pixels from the end still count as the end.

::example{name="MessageScrollerStreamingExample" reset height=19}
::

## Opening Saved Threads

`defaultScrollPosition` sets where the viewport opens. `"end"`, the default, opens at the latest message and follows. `"start"` opens at the first message and does not follow.

```vue
<template>
  <MessageScroller default-scroll-position="start">
    <!-- saved transcript -->
  </MessageScroller>
</template>
```

A saved thread with anchored items opens at the last anchor. Set `scrollAnchor` on user messages to open at the last question, with its reply below.

## Loading Earlier Messages

Loading older messages must not move what the reader sees. When `items` gets a new first ID and still holds the previous first ID, `MessageScrollerContent` keeps the visible content in place. `preserveScrollOnPrepend` turns this on by default. While the reader follows the live edge, the view stays at the end.

Scroll up below, then select **Load earlier messages**.

::example{name="MessageScrollerPrependExample" reset height=23}
::

Pass message IDs to `items` in order. Other rows, such as a "load earlier" button, need no ID.

## Jumping to Messages

Search results, permalinks, and outlines move the transcript from outside the list. The root slot gives `scrollToMessage(id, options)` to every control inside `MessageScroller`, also outside the viewport, like the turn buttons here.

::example{name="MessageScrollerJumpExample" height=20}
::

`scrollToMessage()` stops following unless you pass `block: 'end'`. In a nested component, use `useMessageScroller()`:

```vue [JumpToMessage.vue]
<script setup lang="ts">
import { useMessageScroller } from "@vite-hub/ui/headless";

const props = defineProps<{ id: string }>();
const { scrollToMessage } = useMessageScroller();
</script>

<template>
  <button type="button" @click="scrollToMessage(props.id, { block: 'start' })">Show message</button>
</template>
```

`scrollToMessage()` uses the native `scrollIntoView()`, which can also scroll the page. Use `block: 'nearest'` when the scroller sits in a longer page.

## Reading Scroll State

Read `atEnd` and `isScrollable` for a status line or your own "jump to latest" control. The root slot gives them with `scrollToEnd` and `scrollToMessage`. `useMessageScroller()` gives them as read-only refs.

::example{name="MessageScrollerStateExample" height=20}
::

For styles, use data attributes: the viewport has `data-at-end` at the live edge, and the button has `data-active="true"` when it can scroll.

## Unstyled

The parts work without `@vite-hub/ui/styles.css`. Give the viewport a height and `overflow-y: auto`. The parts still set `overflow-anchor: none` on the viewport and items, so the browser does not move content on its own.

## Accessibility

- The viewport is a focusable `role="region"` named **Messages**. Pass `aria-label` to rename it.
- The content has `role="log"` and announces new rows. Set `aria-busy` on it while streaming, as `Chat` does.
- The button is a native button named **Scroll to latest message**. At the live edge it is hidden, inert, and has `tabindex="-1"`, so it adds no focus stop. On select, it moves focus to the viewport.
- With reduced motion, smooth scrolling becomes instant.

## API Reference

### MessageScroller

The root. Renders a `div` with `data-slot="message-scroller"` and shares the scroll state with the other parts.

#### Props

| Prop                    | Type               | Default | Description                                                     |
| ----------------------- | ------------------ | ------- | --------------------------------------------------------------- |
| `as`                    | `string`           | `"div"` | Rendered element.                                               |
| `autoScroll`            | `boolean`          | `true`  | Follows new content at the end. |
| `defaultScrollPosition` | `'start' \| 'end'` | `"end"` | Initial position.                                               |
| `edgeThreshold`         | `number`           | `8`     | Distance in pixels that counts as the end.                      |
| `previousItemPeek`      | `number`           | `64`    | Pixels of the previous item kept visible when an anchor mounts. |

#### Slots

| Slot      | Scope                                                  | Description                         |
| --------- | ------------------------------------------------------ | ----------------------------------- |
| `default` | `{ atEnd, isScrollable, scrollToEnd, scrollToMessage }` | The viewport, button, and controls. |

### MessageScrollerViewport

Renders a `div` with `data-slot="message-scroller-viewport"`, and `data-at-end` at the live edge.

#### Props

| Prop | Type     | Default | Description       |
| ---- | -------- | ------- | ----------------- |
| `as` | `string` | `"div"` | Rendered element. |

### MessageScrollerContent

Renders a `div` with `data-slot="message-scroller-content"` and `role="log"`.

#### Props

| Prop                      | Type                | Default | Description                                                  |
| ------------------------- | ------------------- | ------- | ------------------------------------------------------------ |
| `as`                      | `string`            | `"div"` | Rendered element.                                            |
| `items`                   | `readonly string[]` | `[]`    | Item IDs in order. A new first ID means rows were prepended. |
| `preserveScrollOnPrepend` | `boolean`           | `true`  | Keeps visible content in place on prepend. |

### MessageScrollerItem

One row. Renders a `div` with `data-slot="message-scroller-item"` and `data-message-id`.

#### Props

| Prop           | Type      | Default  | Description                                                       |
| -------------- | --------- | -------- | ----------------------------------------------------------------- |
| `messageId`    | `string`  | Required | Stable ID for `scrollToMessage()`. |
| `as`           | `string`  | `"div"`  | Rendered element.                                                 |
| `scrollAnchor` | `boolean` | `false`  | On mount, scrolls this item to the top, minus `previousItemPeek`, and stops following. `Chat` sets it on the last user message. |

### MessageScrollerButton

Renders a `button` with `data-slot="message-scroller-button"` and `data-active`.

#### Props

| Prop       | Type                                 | Default    | Description                         |
| ---------- | ------------------------------------ | ---------- | ----------------------------------- |
| `as`       | `string \| Component`                | `"button"` | Rendered element or component.      |
| `behavior` | `'auto' \| 'instant' \| 'smooth'`    | `"smooth"` | Scroll behavior when selected.      |

#### Slots

| Slot      | Scope             | Description                                |
| --------- | ----------------- | ------------------------------------------ |
| `default` | `{ scrollToEnd }` | Button content. Defaults to an arrow.      |

### useMessageScroller

Returns the state and commands of the nearest `MessageScroller`.

```ts fragment
function useMessageScroller(): MessageScrollerContext;

interface MessageScrollerContext {
  atEnd: Readonly<Ref<boolean>>;
  isScrollable: Readonly<Ref<boolean>>;
  scrollToEnd: (options?: { behavior?: MessageScrollBehavior }) => void;
  scrollToMessage: (id: string, options?: { behavior?: MessageScrollBehavior; block?: ScrollLogicalPosition }) => void;
  viewport: Ref<HTMLElement | null>;
}
```

Call it inside `MessageScroller`. Outside, it throws `UI_R0002`.

`calculatePrependScrollTop(previousTop, previousHeight, nextHeight)` returns the scroll position that keeps content in place after a prepend. Use it in your own scroller.

## Related

- [Chat](/docs/ui/chat) is the styled component on these parts.
- [Installation](/docs/ui/installation#defaults) sets the default `edgeThreshold` and `previousItemPeek` for `Chat`.
