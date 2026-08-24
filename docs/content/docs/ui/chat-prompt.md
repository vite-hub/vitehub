---
title: Chat Prompt
description: Compose Nuxt UI's prompt behavior with attachments and an AI SDK status-aware submit control.
navigation.order: 14
navigation.group: Chat
icon: i-ph-paper-plane-tilt-light
---

`AgentChatPrompt` retains Nuxt UI's autoresize, IME handling, Enter behavior, Escape blur, error state, and submit button states. ViteHub adds an attachment row and one submit payload.

::component-preview{name="ChatPromptExample"}
::

```vue
<AgentChatPrompt
  v-model="input"
  v-model:files="files"
  accept="image/*,.pdf"
  :status
  @submit="({ text, files }) => sendMessage({ text, files })"
  @stop="stop"
/>
```

## Events

| Event               | Payload                                                     |
| ------------------- | ----------------------------------------------------------- |
| `update:modelValue` | Current prompt text.                                        |
| `update:files`      | Current `FileUIPart[]`.                                     |
| `submit`            | `{ text, files }`. Empty text is accepted when files exist. |
| `stop`              | No payload. Connect it to the AI SDK `stop()` helper.       |

Use `#files`, `#actions`, and `#submit` to replace each built-in section without rebuilding keyboard behavior.
