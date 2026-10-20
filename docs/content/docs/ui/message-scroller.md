---
title: Message Scroller
description: "Compose headless message scrolling with live-edge following, prepend preservation, and message jumps."
navigation.order: 41
navigation.group: Utilities
icon: i-ph-scroll-light
---

The message scroller is the scrolling layer under `Chat`. It follows new content only while the reader stays at the live edge, keeps the position when older messages are added above, and can jump to a message ID. The parts have the same names and `data-slot` attributes as the [shadcn/ui Message Scroller](https://ui.shadcn.com/docs/components/message-scroller).

The scroller does not own messages, Agent state, transport, or persistence. Put any row in it: a message, a marker, a log line, or a "load earlier" row.

::component-preview{name="MessageScrollerExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The parts are headless. Import them from the focused entry `@vite-hub/ui/headless`, which does not load styles or need Nuxt UI. The Nuxt module does not auto-import them:

```ts
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "@vite-hub/ui/headless";
```

`@vite-hub/ui/styles.css` gives the parts the shadcn/ui layout: a full-height root, a thin-scrollbar viewport, `1.5rem` between items, and a centered button at the bottom. The Nuxt module loads it for you.

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

`MessageScroller` fills its parent. Put it in a container with a fixed height.

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

- `MessageScroller` is the root. It owns the scroll state and the behavior props.
- `MessageScrollerViewport` is the scrollable element. It reads wheel, pointer, and keyboard input to stop following.
- `MessageScrollerContent` holds the rows. Its `items` prop tells the scroller when rows are prepended.
- `MessageScrollerItem` wraps each row. Wrap every direct child of the content, so the scroller can anchor it and jump to it.
- `MessageScrollerButton` scrolls to the latest message. It is hidden and inert at the live edge.

## Features

- Follows new content only while the reader is at the live edge.
- Stops following when the reader scrolls up with the wheel, the pointer, or the keyboard.
- Moves a new turn near the top with `scrollAnchor` and keeps part of the previous item visible.
- Keeps the visible content in place when older messages are prepended.
- Jumps to any item by ID with `scrollToMessage()`.
- Gives `atEnd` and `isScrollable` to your code through the root slot and `useMessageScroller()`.
- Has no styles of its own. `@vite-hub/ui/styles.css` adds the shadcn/ui layout.

## Anchoring Turns

A turn starts a new exchange. In an Agent chat, it is usually the user message and the reply after it. Set `scrollAnchor` on the row that starts the turn. When that row mounts, the viewport moves it near the top and stops following, so the reply grows into the space below it.

Any row can be an anchor: a user message, an assistant reply, or a marker. Select **User** or **Assistant** in the example below, then send a message.

::component-preview{name="MessageScrollerAnchorExample" reset}
::

The anchor can only move as far up as the content allows. Give the content bottom padding, as `Chat` does, so a new turn has room to reach the top.

## Keeping Context Visible

`previousItemPeek` keeps part of the previous item visible above a new anchor. The reader sees where the new turn connects to the conversation.

```vue
<template>
  <!-- Keep 64px of the previous turn visible above the anchored row. -->
  <MessageScroller :previous-item-peek="64">
    <!-- anchored turns -->
  </MessageScroller>
</template>
```

## Following the Live Edge

When the reader is at the end, `autoScroll` keeps new content in view. It reacts to new rows, to text that grows in a row, and to size changes. The reader stops following with the wheel, a pointer drag on the scrollbar, or the `ArrowUp`, `Home`, `PageUp`, and `Shift+Space` keys. New lines then arrive without moving the view. `MessageScrollerButton` returns to the end and follows again.

`edgeThreshold` sets how many pixels from the end still count as the end.

::component-preview{name="MessageScrollerStreamingExample" reset}
::

## Opening Saved Threads

`defaultScrollPosition` sets where the viewport opens. The default `"end"` opens at the latest message and follows. `"start"` opens at the first message and does not follow.

```vue
<template>
  <MessageScroller default-scroll-position="start">
    <!-- saved transcript -->
  </MessageScroller>
</template>
```

When a saved thread mounts with anchored items, the viewport opens at the last anchor. Set `scrollAnchor` on user messages to open the thread at the last question, with its reply below it.

## Loading Earlier Messages

Loading older messages must not move the messages that the reader sees. When a new first ID appears in `items` and the previous first ID is still in the list, `MessageScrollerContent` keeps the visible content in place. `preserveScrollOnPrepend` turns this on by default. While the reader follows the live edge, the view stays at the end.

Scroll up in the example below, then select **Load earlier messages**.

::component-preview{name="MessageScrollerPrependExample" reset}
::

Pass message IDs to `items`, in order. Rows that are not messages, such as a "load earlier" button, do not need an ID in the list.

## Jumping to Messages

Search results, permalinks, and outlines move the transcript from outside the list. The root slot gives `scrollToMessage(id, options)` to every control inside `MessageScroller`. The control can be outside the viewport, as the turn buttons in this example are.

::component-preview{name="MessageScrollerJumpExample"}
::

`scrollToMessage()` stops following, unless you pass `block: 'end'`. In a nested component, call `useMessageScroller()` instead:

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

`scrollToMessage()` uses the native `scrollIntoView()`, which can also scroll the page. Use `block: 'nearest'` when the scroller is part of a longer page.

## Reading Scroll State

Read `atEnd` and `isScrollable` when you need scroll state in code, for example for a status line or your own "jump to latest" control. The root slot gives them with `scrollToEnd` and `scrollToMessage`. `useMessageScroller()` gives them as read-only refs.

::component-preview{name="MessageScrollerStateExample"}
::

For styles, use the data attributes. The viewport has `data-at-end` at the live edge. The button has `data-active="true"` when it can scroll.

## Unstyled

The parts work without `@vite-hub/ui/styles.css`. Then give the viewport a height and `overflow-y: auto`. The parts still set `overflow-anchor: none` on the viewport and each item, so the browser does not move the content on its own.

## Accessibility

- The viewport is a keyboard-focusable `role="region"` named **Messages**. Pass `aria-label` for another name.
- The content has `role="log"` and announces additions. Set `aria-busy` on it while content streams, as `Chat` does.
- The button has the accessible name **Scroll to latest message** and is a native button by default. At the live edge it is hidden, inert, and has `tabindex="-1"`, so it does not add a focus stop. When selected, it moves focus back to the viewport.
- When the reader asks for reduced motion, smooth scrolling becomes instant.

## API Reference

### MessageScroller

The root. Renders a `div` with `data-slot="message-scroller"` and provides the scroll state to the other parts.

#### Props

| Prop                    | Type               | Default | Description                                                     |
| ----------------------- | ------------------ | ------- | --------------------------------------------------------------- |
| `as`                    | `string`           | `"div"` | Rendered element.                                               |
| `autoScroll`            | `boolean`          | `true`  | Follows new content while the reader is at the end.             |
| `defaultScrollPosition` | `'start' \| 'end'` | `"end"` | Initial position.                                               |
| `edgeThreshold`         | `number`           | `8`     | Distance in pixels that counts as the end.                      |
| `previousItemPeek`      | `number`           | `64`    | Pixels of the previous item that stay visible when a scroll anchor mounts. |

#### Slots

| Slot      | Scope                                                  | Description                         |
| --------- | ------------------------------------------------------ | ----------------------------------- |
| `default` | `{ atEnd, isScrollable, scrollToEnd, scrollToMessage }` | The viewport, the button, and any controls. |

### MessageScrollerViewport

The scrollable element. Renders a `div` with `data-slot="message-scroller-viewport"`, and `data-at-end` at the live edge.

#### Props

| Prop | Type     | Default | Description       |
| ---- | -------- | ------- | ----------------- |
| `as` | `string` | `"div"` | Rendered element. |

### MessageScrollerContent

The row container. Renders a `div` with `data-slot="message-scroller-content"` and `role="log"`.

#### Props

| Prop                      | Type                | Default | Description                                                  |
| ------------------------- | ------------------- | ------- | ------------------------------------------------------------ |
| `as`                      | `string`            | `"div"` | Rendered element.                                            |
| `items`                   | `readonly string[]` | `[]`    | Item IDs in order. A new first ID means content was prepended. |
| `preserveScrollOnPrepend` | `boolean`           | `true`  | Keeps the visible content in place when items are prepended. |

### MessageScrollerItem

One row. Renders a `div` with `data-slot="message-scroller-item"` and `data-message-id`.

#### Props

| Prop           | Type      | Default  | Description                                                       |
| -------------- | --------- | -------- | ----------------------------------------------------------------- |
| `messageId`    | `string`  | Required | Stable ID for `scrollToMessage()`.                                |
| `as`           | `string`  | `"div"`  | Rendered element.                                                 |
| `scrollAnchor` | `boolean` | `false`  | On mount, scrolls this item to the top, minus `previousItemPeek`, and stops following. `Chat` sets it on the last user message. |

### MessageScrollerButton

The scroll control. Renders a `button` with `data-slot="message-scroller-button"` and `data-active`.

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

Returns the scroll state and commands of the nearest `MessageScroller`.

```ts
function useMessageScroller(): MessageScrollerContext;

interface MessageScrollerContext {
  atEnd: Readonly<Ref<boolean>>;
  isScrollable: Readonly<Ref<boolean>>;
  scrollToEnd: (options?: { behavior?: MessageScrollBehavior }) => void;
  scrollToMessage: (id: string, options?: { behavior?: MessageScrollBehavior; block?: ScrollLogicalPosition }) => void;
  viewport: Ref<HTMLElement | null>;
}
```

Call it under `MessageScroller`. Outside a root, it throws `UI_R0002`.

`calculatePrependScrollTop(previousTop, previousHeight, nextHeight)` returns the scroll position that keeps content in place after a prepend. Use it when you build your own scroller.

## Related

- [Chat](/docs/ui/chat) is the styled component built on these primitives.
- [Installation](/docs/ui/installation#defaults) sets the default `edgeThreshold` and `previousItemPeek` for `Chat`.
