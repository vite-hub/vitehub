---
title: Message
description: "Lay out one conversation turn with an avatar, a header, content, and a footer."
navigation.order: 10
navigation.group: Parts
icon: i-ph-chat-centered-text-light
---

`Message` is one row of a conversation. It aligns the turn to the start or the end and holds an avatar, a header, the content, and a footer. Put a [Bubble](/docs/ui/bubble), a [Trace](/docs/ui/trace), or any other content inside `MessageContent`. The parts have the same names, props, and `data-slot` attributes as the [shadcn/ui Message](https://ui.shadcn.com/docs/components/message).

::component-preview{name="MessageExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/message`:

```ts
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageGroup, MessageHeader } from "@vite-hub/ui";
```

## Usage

```ts
import { Bubble, BubbleContent, Message, MessageAvatar, MessageContent } from "@vite-hub/ui";
```

```vue
<template>
  <Message>
    <MessageAvatar>
      <UAvatar src="/agent.png" alt="Agent" />
    </MessageAvatar>
    <MessageContent>
      <Bubble variant="secondary">
        <BubbleContent>The lockfile was out of date.</BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>
</template>
```

`Message` owns the row layout: the avatar, the alignment, the header, and the footer. Put the visible surface inside it with [Bubble](/docs/ui/bubble). For the scroll container around a conversation, use [Message Scroller](/docs/ui/message-scroller).

## Composition

```text
Message
├── MessageAvatar
└── MessageContent
    ├── MessageHeader
    ├── Bubble, Trace, or other content
    └── MessageFooter
```

Use `MessageGroup` to stack consecutive messages from the same sender:

```text
MessageGroup
├── Message
└── Message
```

## Features

- Start and end alignment for the sender and the receiver through `align`.
- An avatar slot at the bottom of the message. When the message has a footer, the avatar moves up to stay next to the content.
- Header and footer slots for sender names, status, and message actions.
- The footer follows the side of the message, so actions stay aligned on `align="end"` rows.
- `MessageGroup` stacks consecutive messages from the same sender.
- The default styles are in the `components` layer of `@vite-hub/ui/styles.css`, so a utility class such as `class="max-w-lg"` overrides them.

## Avatar

Use `MessageAvatar` to show an avatar next to the message. Set `align="end"` on the message to put the avatar at the end.

::component-preview{name="MessageAvatarExample"}
::

| Align   | Description                                          |
| ------- | ---------------------------------------------------- |
| `start` | Aligns the message to the start of the conversation. |
| `end`   | Aligns the message to the end of the conversation.   |

## Group

Use `MessageGroup` to stack consecutive messages from the same sender. Put an empty `MessageAvatar` on the earlier messages, so they align with the avatar on the last one.

::component-preview{name="MessageGroupExample"}
::

## Header and Footer

Use `MessageHeader` for a sender name and `MessageFooter` for metadata, such as a delivery or read status. Without a framed bubble, the header and footer align with the unframed content.

::component-preview{name="MessageHeaderFooterExample"}
::

## Actions

Put message actions in `MessageFooter`, such as copy, retry, or feedback buttons.

::component-preview{name="MessageActionsExample"}
::

## Attachment

Put an [Attachment](/docs/ui/attachment) in `MessageContent` next to the bubble to show an image or a file in the turn.

::component-preview{name="MessageAttachmentExample"}
::

## Accessibility

`Message` is a layout wrapper with no role. The content in it gives the accessibility.

### Label icon-only actions

Action buttons in `MessageFooter` often show only an icon. Give each one an `aria-label`.

```vue
<MessageFooter>
  <UButton color="neutral" variant="ghost" size="sm" square icon="i-ph-copy-light" aria-label="Copy" />
</MessageFooter>
```

### Status updates

The parts do not announce new messages. Put the conversation in an element with `role="log"`, as [Chat](/docs/ui/chat) does, when new turns arrive while the reader waits. For a message in progress, use a [Marker](/docs/ui/marker) with `role="status"`.

```vue
<Marker role="status">
  <MarkerIcon><UIcon name="i-ph-circle-dashed-light" /></MarkerIcon>
  <MarkerContent>Checking the logs</MarkerContent>
</Marker>
```

## API Reference

### Message

The row of one message. Renders a `div` with `data-slot="message"`.

#### Props

| Prop    | Type               | Default   | Description                                       |
| ------- | ------------------ | --------- | ------------------------------------------------- |
| `align` | `"start" \| "end"` | `"start"` | The alignment of the message in the conversation. |

### MessageGroup

Stacks consecutive messages from the same sender. Has no props. Renders a `div` with `data-slot="message-group"`.

### MessageAvatar

The avatar slot at the bottom of the message. When the message has a `MessageFooter`, the avatar moves up to stay next to the content. Has no props. Renders a `div` with `data-slot="message-avatar"`.

### MessageContent

Holds the header, the content, and the footer. Has no props. Renders a `div` with `data-slot="message-content"`.

### MessageHeader

Shows content above the message, such as a sender name. It aligns to the side of the message. Has no props. Renders a `div` with `data-slot="message-header"`.

### MessageFooter

Shows content below the message, such as status or actions. It aligns to the side of the message. Has no props. Renders a `div` with `data-slot="message-footer"`.

Each part passes `class` and other attributes to its element.

## Related

- [Bubble](/docs/ui/bubble) frames the text of a turn.
- [Chat message](/docs/ui/chat-message) renders an AI SDK `UIMessage`.
