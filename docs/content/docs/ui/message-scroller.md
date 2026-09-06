---
title: Message Scroller
description: Compose headless message scrolling with live-edge, prepend, and jump behavior.
navigation.order: 41
navigation.group: Utilities
icon: i-ph-scroll-light
---

The message scroller is the headless layer of the package. It follows streaming output only while the reader remains at the live edge, preserves position when older messages prepend, and can jump to a stable message ID.

::component-preview{name="MessageScrollerExample"}
::

## Anatomy

```vue
<MessageScrollerRoot>
  <MessageScrollerViewport>
    <MessageScrollerContent :items="messages.map(message => message.id)">
      <MessageScrollerItem
        v-for="message in messages"
        :key="message.id"
        :message-id="message.id"
      >
        {{ message }}
      </MessageScrollerItem>
    </MessageScrollerContent>
  </MessageScrollerViewport>
  <MessageScrollerButton />
</MessageScrollerRoot>
```

Import primitives from `@vite-hub/ui/headless` when you do not want the styled chat component.

## Root props

| Prop                    | Type               | Default |
| ----------------------- | ------------------ | ------- |
| `autoScroll`            | `boolean`          | `true`  |
| `defaultScrollPosition` | `'start' \| 'end'` | `'end'` |
| `edgeThreshold`         | `number`           | `8`     |
| `previousItemPeek`      | `number`           | `64`    |

## Composable

`useMessageScroller()` exposes reactive `atEnd` and `isScrollable` values plus `scrollToEnd()` and `scrollToMessage(id)`. Call it under `MessageScrollerRoot`.

## Accessibility

The viewport is a labelled, keyboard-scrollable region and the content is an additions-only log. `AgentChat` marks that log busy while a response is submitted or streaming, which prevents partial updates from being announced as settled content.

`MessageScrollerButton` has a default accessible label and uses a native button by default. It stays mounted but inert at the live edge, moves focus back to the viewport when activated, and replaces smooth scrolling with instant scrolling when the reader requests reduced motion.
