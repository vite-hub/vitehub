---
title: Chat Message
description: Render one AI SDK UI message as a Message with a user Bubble and customizable part slots.
navigation.order: 21
navigation.group: Chat
icon: i-ph-chat-text-light
---

`ChatMessage` renders one `UIMessage` with the [Message](/docs/ui/message) parts. The user speaks from the end in a secondary [Bubble](/docs/ui/bubble). The assistant replies at the start without a frame. `MessageParts` renders the content. Use it alone for a single message, or let `Chat` render one for each message.

::component-preview{name="ChatMessageExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/chat-message`:

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

Each slot fills one part of the [Message](/docs/ui/message). A slot that you do not use renders no part.

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

- Renders one AI SDK `UIMessage`.
- Puts user text in a secondary `Bubble` at the end. Other roles reply at the start without a frame.
- Renders the content with `MessageParts` and forwards the part slots to it.
- Adds optional header, avatar, and action areas through slots.
- Sets the accessible name from the message role.

## User Message with a Header

Use the `header` slot for metadata above the body, for example an attachment count. File parts render as download links or image previews.

::component-preview{name="ChatMessageUserExample"}
::

## Streaming with a Custom Avatar

Set `streaming` while the response arrives. Text and reasoning parts render in their streaming state. Use the `leading` slot to replace the avatar.

::component-preview{name="ChatMessageStreamingExample"}
::

## Accessibility

- The message has the accessible name **User message**, **Assistant message**, or **System message**. Pass `aria-label` to change it.
- Give icon-only action buttons an `aria-label`.

## API Reference

### ChatMessage

Renders one message as a `Message` with its parts.

#### Props

| Prop        | Type                      | Default  | Description                                               |
| ----------- | ------------------------- | -------- | --------------------------------------------------------- |
| `message`   | `UIMessage`               | Required | The message to render.                                    |
| `streaming` | `boolean`                 | `false`  | Renders text and reasoning parts in the streaming state.  |

Other attributes, such as `class`, go to the `Message` root.

#### Slots

| Slot       | Scope             | Description                                         |
| ---------- | ----------------- | --------------------------------------------------- |
| `default`  | `{ message }`     | Replaces the complete message body.                 |
| `header`   | `{ message }`     | Content above the body, for example files or metadata. |
| `leading`  | `{ message }`     | Replaces the avatar or role marker.                 |
| `actions`  | `{ message }`     | Copy, retry, feedback, or other application actions. |
| Part slots | `{ part, index }` | Forwarded to `MessageParts`, for example `text`, `tool`, or `fallback`. |

## Related

- [Message parts](/docs/ui/message-parts) renders the content of a message.
- [Chat](/docs/ui/chat) renders a list of messages.
- [Markdown](/docs/ui/markdown) renders text parts.
