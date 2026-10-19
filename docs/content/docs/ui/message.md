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

## Usage

```vue
<template>
  <MessageGroup>
    <Message align="end">
      <MessageContent>
        <Bubble>
          <BubbleContent>Why did the deploy fail?</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
    <Message>
      <MessageAvatar>AI</MessageAvatar>
      <MessageContent>
        <MessageHeader>Reviewer</MessageHeader>
        <Bubble variant="secondary">
          <BubbleContent>The lockfile was out of date.</BubbleContent>
        </Bubble>
        <MessageFooter>2 min ago</MessageFooter>
      </MessageContent>
    </Message>
  </MessageGroup>
</template>
```

The parts compose as follows:

```text
MessageGroup
└── Message
    ├── MessageAvatar
    └── MessageContent
        ├── MessageHeader
        ├── Bubble, Trace, or other content
        └── MessageFooter
```

Add a utility class to any part to change it, for example `class="max-w-lg"`. The default styles are in the `components` layer of `@vite-hub/ui/styles.css`, so Tailwind utilities override them.

## API reference

### Message

#### Props

| Prop    | Type               | Default   | Description                                       |
| ------- | ------------------ | --------- | ------------------------------------------------- |
| `align` | `"start" \| "end"` | `"start"` | The alignment of the message in the conversation. |

`MessageGroup`, `MessageAvatar`, `MessageContent`, `MessageHeader`, and `MessageFooter` have no props. Each one renders a `div` with its `data-slot` and passes `class` and other attributes to it.

## Accessibility

- Give icon-only actions in the header or footer an `aria-label`.
- The parts do not announce new messages. Put the conversation in an element with `role="log"`, as [Chat](/docs/ui/chat) does, when new turns arrive while the reader waits.

## Related

- [Bubble](/docs/ui/bubble) frames the text of a turn.
- [Chat message](/docs/ui/chat-message) renders an AI SDK `UIMessage`.
