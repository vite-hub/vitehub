---
title: Chat Message
description: Render one AI SDK UI message as a Message with a user Bubble and customizable part slots.
navigation.order: 21
navigation.group: Chat
icon: i-lucide-message-square-text
---

`ChatMessage` renders one `UIMessage` with the [Message](/docs/ui/message) parts. User text sits at the end in a secondary [Bubble](/docs/ui/bubble). Other roles reply at the start without a frame. `MessageParts` renders the content. Use it alone, or let `Chat` render one per message.

::example{name="ChatMessageExample" height=16}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui`:

```ts
import { ChatMessage } from "@vite-hub/ui";
```

## Usage

```ts
import { ChatMessage } from "@vite-hub/ui";
```

```vue
<ChatMessage :message="message" :streaming="status === 'streaming'">
  <template #actions="{ message }">
    <UButton icon="i-lucide-copy" aria-label="Copy message" variant="ghost" @click="copy(message)" />
  </template>
</ChatMessage>
```

## Composition

Each slot fills one part of the [Message](/docs/ui/message). An unused slot renders nothing.

```text
Message, aligned to the end for the user and to the start for others
├── MessageAvatar, with the leading slot
└── MessageContent
    ├── MessageHeader, with the header slot
    ├── body, or the default slot
    │   ├── user: Bubble > BubbleContent > MessageParts
    │   └── assistant and system: MessageParts
    └── MessageFooter, with the actions slot
```

## Features

- Passes the part slots to `MessageParts`.
- Optional header, avatar, and action slots.
- Takes its accessible name from the message role.

## User Message with a Header

Use the `header` slot for details above the body, such as an attachment count. File parts render as download links or image previews.

::example{name="ChatMessageUserExample" height=8}
::

## Streaming with a Custom Avatar

Set `streaming` while the response arrives, so text and reasoning parts stream. The `leading` slot replaces the avatar.

::example{name="ChatMessageStreamingExample" height=8}
::

## Accessibility

- The message is named **User message**, **Assistant message**, or **System message**. Pass `aria-label` to change it.
- Give icon-only action buttons an `aria-label`.

## API Reference

### ChatMessage

Renders one message as a `Message` with its parts.

#### Props

| Prop        | Type                      | Default  | Description                                               |
| ----------- | ------------------------- | -------- | --------------------------------------------------------- |
| `message`   | `UIMessage`               | Required | The message to render.                                    |
| `streaming` | `boolean`                 | `false`  | Renders text and reasoning parts as streaming. |

Other attributes, such as `class`, go to the `Message` root.

#### Slots

| Slot       | Scope             | Description                                         |
| ---------- | ----------------- | --------------------------------------------------- |
| `default`  | `{ message }`     | Replaces the whole body. |
| `header`   | `{ message }`     | Content above the body, such as files or details. |
| `leading`  | `{ message }`     | Replaces the avatar or role marker.                 |
| `actions`  | `{ message }`     | Copy, retry, feedback, or other actions. |
| Part slots | `{ part, index }` | Passed to `MessageParts`, such as `text`, `tool`, or `fallback`. |

## Related

- [Message parts](/docs/ui/message-parts) renders the content of a message.
- [Chat](/docs/ui/chat) renders a list of messages.
- [Markdown](/docs/ui/markdown) renders text parts.
