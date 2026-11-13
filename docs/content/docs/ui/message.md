---
title: Message
description: "Lay out one conversation turn with an avatar, a header, content, and a footer."
navigation.order: 10
navigation.group: Parts
icon: i-lucide-message-square-text
---

`Message` is one row of a conversation. It aligns the turn to the start or end and holds an avatar, header, content, and footer. Put a [Bubble](/docs/ui/bubble), a [Trace](/docs/ui/trace), or other content in `MessageContent`. The parts match the names, props, and `data-slot` attributes of the [shadcn/ui Message](https://ui.shadcn.com/docs/components/message).

::example{name="MessageExample" height=25}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui`:

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

`Message` handles the row layout. Put the visible surface in it with [Bubble](/docs/ui/bubble). To scroll a conversation, use [Message Scroller](/docs/ui/message-scroller).

## Composition

```text
Message
├── MessageAvatar
└── MessageContent
    ├── MessageHeader
    ├── Bubble, Trace, or other content
    └── MessageFooter
```

`MessageGroup` stacks consecutive messages from one sender:

```text
MessageGroup
├── Message
└── Message
```

## Features

- Start and end alignment with `align`.
- An avatar at the bottom of the message. With a footer, the avatar moves up to stay next to the content.
- Header and footer for sender names, status, and actions.
- The footer follows the message side, so actions stay aligned on `align="end"` rows.
- Default styles sit in the `components` layer of `@vite-hub/ui/styles.css`, so a utility class such as `class="max-w-lg"` overrides them.

## Avatar

`MessageAvatar` shows an avatar next to the message. Set `align="end"` on the message to put it at the end.

::example{name="MessageAvatarExample" height=20}
::

| Align   | Description                                          |
| ------- | ---------------------------------------------------- |
| `start` | The start of the conversation. |
| `end`   | The end of the conversation. |

## Group

Stack consecutive messages from one sender. Put an empty `MessageAvatar` on earlier messages, so they align with the last one's avatar.

::example{name="MessageGroupExample" height=8}
::

## Header and Footer

Use `MessageHeader` for a sender name and `MessageFooter` for details, such as delivery or read status. Without a framed bubble, they align with the unframed content.

::example{name="MessageHeaderFooterExample" height=12}
::

## Actions

Put actions in `MessageFooter`, such as copy, retry, or feedback buttons.

::example{name="MessageActionsExample" height=14}
::

## Attachment

Put an [Attachment](/docs/ui/attachment) in `MessageContent` next to the bubble to show an image or file.

::example{name="MessageAttachmentExample" height=30}
::

## Accessibility

`Message` is a layout wrapper with no role. Its content gives the semantics.

### Label icon-only actions

Footer action buttons often show only an icon. Give each one an `aria-label`.

```vue
<MessageFooter>
  <UButton color="neutral" variant="ghost" size="sm" square icon="i-lucide-copy" aria-label="Copy" />
</MessageFooter>
```

### Status updates

The parts do not announce new messages. When new turns arrive while the reader waits, put the conversation in an element with `role="log"`, as [Chat](/docs/ui/chat) does. For a message in progress, use a [Marker](/docs/ui/marker) with `role="status"`.

```vue
<Marker role="status">
  <MarkerIcon><UIcon name="i-lucide-circle-dashed" /></MarkerIcon>
  <MarkerContent>Checking the logs</MarkerContent>
</Marker>
```

## API Reference

### Message

Renders a `div` with `data-slot="message"`.

#### Props

| Prop    | Type               | Default   | Description                                       |
| ------- | ------------------ | --------- | ------------------------------------------------- |
| `align` | `"start" \| "end"` | `"start"` | Message alignment in the conversation. |

### MessageGroup

Stacks consecutive messages from one sender. No props. Renders a `div` with `data-slot="message-group"`.

### MessageAvatar

The avatar at the bottom of the message. With a `MessageFooter`, it moves up to stay next to the content. No props. Renders a `div` with `data-slot="message-avatar"`.

### MessageContent

Holds the header, content, and footer. No props. Renders a `div` with `data-slot="message-content"`.

### MessageHeader

Content above the message, such as a sender name, on the message side. No props. Renders a `div` with `data-slot="message-header"`.

### MessageFooter

Content below the message, such as status or actions, on the message side. No props. Renders a `div` with `data-slot="message-footer"`.

Each part passes `class` and other attributes to its element.

## Related

- [Bubble](/docs/ui/bubble) frames the text of a turn.
- [Chat message](/docs/ui/chat-message) renders an AI SDK `UIMessage`.
