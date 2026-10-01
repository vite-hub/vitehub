---
title: Message Scroller
description: "Compose headless message scrolling with live-edge following, prepend preservation, and message jumps."
navigation.order: 41
navigation.group: Utilities
icon: i-ph-scroll-light
---

The message scroller is the headless layer under `AgentChat`. It follows new content only while the reader stays at the live edge, keeps the position when older messages are added above, and can jump to a message ID. Use it when you want chat scrolling with your own markup and styles. It does not load styles or need Nuxt UI.

::component-preview{name="MessageScrollerExample"}
::

## Usage

Import the primitives from `@vite-hub/ui/headless`:

```vue
<script setup lang="ts">
import {
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerRoot,
  MessageScrollerViewport,
} from "@vite-hub/ui/headless";
</script>

<template>
  <MessageScrollerRoot>
    <MessageScrollerViewport>
      <MessageScrollerContent :items="messages.map((message) => message.id)">
        <MessageScrollerItem v-for="message in messages" :key="message.id" :message-id="message.id">
          {{ message.text }}
        </MessageScrollerItem>
      </MessageScrollerContent>
    </MessageScrollerViewport>
    <MessageScrollerButton />
  </MessageScrollerRoot>
</template>
```

Give the viewport a height and `overflow-y: auto`.

## Examples

### Live output

New lines arrive every second. Scroll up to stop following. The button appears and returns you to the end.

::component-preview{name="MessageScrollerStreamingExample" reset}
::

### Jump to a message

Call `useMessageScroller()` in a component inside `MessageScrollerRoot`:

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

## API reference

### MessageScrollerRoot

#### Props

| Prop                    | Type               | Default | Description                                                     |
| ----------------------- | ------------------ | ------- | --------------------------------------------------------------- |
| `as`                    | `string`           | `'div'` | Rendered element.                                               |
| `autoScroll`            | `boolean`          | `true`  | Follows new content while the reader is at the end.             |
| `defaultScrollPosition` | `'start' \| 'end'` | `'end'` | Initial position.                                               |
| `edgeThreshold`         | `number`           | `8`     | Distance in pixels that counts as the end.                      |
| `previousItemPeek`      | `number`           | `64`    | Pixels of the previous item that stay visible when a scroll anchor mounts. |

### MessageScrollerViewport

#### Props

| Prop | Type     | Default | Description       |
| ---- | -------- | ------- | ----------------- |
| `as` | `string` | `'div'` | Rendered element. |

### MessageScrollerContent

#### Props

| Prop                      | Type                | Default | Description                                                  |
| ------------------------- | ------------------- | ------- | ------------------------------------------------------------ |
| `as`                      | `string`            | `'div'` | Rendered element.                                            |
| `items`                   | `readonly string[]` | `[]`    | Item IDs in order. A new first ID means content was prepended. |
| `preserveScrollOnPrepend` | `boolean`           | `true`  | Keeps the visible content in place when items are prepended. |

### MessageScrollerItem

#### Props

| Prop           | Type      | Default  | Description                                                       |
| -------------- | --------- | -------- | ----------------------------------------------------------------- |
| `messageId`    | `string`  | Required | Stable ID for `scrollToMessage()`.                                |
| `as`           | `string`  | `'div'`  | Rendered element.                                                 |
| `scrollAnchor` | `boolean` | `false`  | On mount, scrolls this item to the top, minus `previousItemPeek`, and stops following. `AgentChat` sets it on the last user message. |

### MessageScrollerButton

#### Props

| Prop       | Type                                 | Default    | Description                         |
| ---------- | ------------------------------------ | ---------- | ----------------------------------- |
| `as`       | `string \| Component`                | `'button'` | Rendered element or component.      |
| `behavior` | `'auto' \| 'instant' \| 'smooth'`    | `'smooth'` | Scroll behavior when selected.      |

#### Slots

| Slot      | Scope             | Description                                |
| --------- | ----------------- | ------------------------------------------ |
| `default` | `{ scrollToEnd }` | Button content. Defaults to an arrow.      |

### useMessageScroller

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

Call it under `MessageScrollerRoot`. Outside a root, it throws `UI_R0002`.

`calculatePrependScrollTop(previousTop, previousHeight, nextHeight)` returns the scroll position that keeps content in place after a prepend. Use it when you build your own scroller.

## Accessibility

- The viewport is a keyboard-focusable `role="region"` named **Messages**. Pass `aria-label` for another name.
- The content has `role="log"` and announces additions. Set `aria-busy` on it while content streams, as `AgentChat` does.
- The button has the accessible name **Scroll to latest message** and is a native button by default. At the live edge it is hidden and inert. When selected, it moves focus back to the viewport.
- When the reader asks for reduced motion, smooth scrolling becomes instant.

## Related

- [Chat](/docs/ui/chat) is the styled component built on these primitives.
- [Installation](/docs/ui/installation#defaults) sets the default `edgeThreshold` and `previousItemPeek` for `AgentChat`.
