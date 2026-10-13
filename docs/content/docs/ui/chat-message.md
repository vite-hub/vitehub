---
title: Chat Message
description: Render one AI SDK UI message with Nuxt UI chrome and customizable part slots.
navigation.order: 21
navigation.group: Chat
icon: i-ph-chat-text-light
---

`AgentChatMessage` renders one `UIMessage`. It composes Nuxt UI's `UChatMessage` for the role layout and `AgentMessageParts` for the content. Use it alone for a single message, or let `AgentChat` render one for each message.

::component-preview{name="ChatMessageExample"}
::

## Usage

```vue
<AgentChatMessage :message="message" :streaming="status === 'streaming'">
  <template #actions="{ message }">
    <UButton icon="i-lucide-copy" aria-label="Copy message" variant="ghost" @click="copy(message)" />
  </template>
</AgentChatMessage>
```

## Examples

### User message with a header

Use the `header` slot for metadata above the body, for example an attachment count. File parts render as download links or image previews.

::component-preview{name="ChatMessageUserExample"}
::

### Streaming with a custom avatar

Set `streaming` while the response arrives. Text and reasoning parts render in their streaming state. Use the `leading` slot to replace the avatar.

::component-preview{name="ChatMessageStreamingExample"}
::

## API reference

### AgentChatMessage

#### Props

| Prop        | Type                      | Default  | Description                                               |
| ----------- | ------------------------- | -------- | --------------------------------------------------------- |
| `message`   | `UIMessage`               | Required | The message to render.                                    |
| `streaming` | `boolean`                 | `false`  | Renders text and reasoning parts in the streaming state.  |
| `ui`        | `Record<string, unknown>` |          | Nuxt UI slot classes for the underlying `UChatMessage`.   |

Other attributes go to `UChatMessage`.

#### Slots

| Slot       | Scope             | Description                                         |
| ---------- | ----------------- | --------------------------------------------------- |
| `default`  | `{ message }`     | Replaces the complete message body.                 |
| `header`   | `{ message }`     | Content above the body, for example files or metadata. |
| `leading`  | `{ message }`     | Replaces the avatar or role marker.                 |
| `actions`  | `{ message }`     | Copy, retry, feedback, or other application actions. |
| Part slots | `{ part, index }` | Forwarded to `AgentMessageParts`, for example `text`, `tool`, or `fallback`. |

## Accessibility

- The message has the accessible name **User message**, **Assistant message**, or **System message**. Pass `aria-label` to change it.
- Give icon-only action buttons an `aria-label`.

## Related

- [Message parts](/docs/ui/message-parts) renders the content of a message.
- [Chat](/docs/ui/chat) renders a list of messages.
- [Markdown](/docs/ui/markdown) renders text parts.
