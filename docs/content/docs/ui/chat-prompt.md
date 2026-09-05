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
  @reload="regenerate"
  @stop="stop"
/>
```

## Events

| Event               | Payload                                                     |
| ------------------- | ----------------------------------------------------------- |
| `error`             | Attachment filtering or conversion error.                   |
| `update:modelValue` | Current prompt text.                                        |
| `update:files`      | Current `FileUIPart[]`.                                     |
| `submit`            | `{ text, files }`. Empty text is accepted when files exist. |
| `reload`            | No payload. Connect it to the AI SDK `regenerate()` helper. |
| `stop`              | No payload. Connect it to the AI SDK `stop()` helper.       |

Use `#files`, `#actions`, and `#submit` to replace each built-in section without rebuilding keyboard behavior. The composer, attachment picker, and status-aware submit action have default accessible names; pass `aria-label` to override the composer name.

## Submission behavior

Enter and form submission emit `submit` only when `status` is `ready`, text or files exist, and all attachment batches have finished conversion. The Send button uses the same guard. You can edit the draft while a response streams or files are being prepared. Stop and Retry remain available in their corresponding states; Enter does not trigger them.

The `#submit` slot receives `{ status, canSubmit, preparingFiles }`. Use `canSubmit` to disable a custom Send button and `preparingFiles` to show file preparation state. Custom Stop and Retry controls can remain active during preparation.

An attachment conversion error emits `error` and releases the submission guard. It does not clear the draft or existing attachments. The application owns draft recovery after a failed send and decides when to clear `input` and `files`. Unmount the prompt when changing to another session to prevent a pending file read from updating that session.

The picker and clipboard paste share the same file path. Pasted images become attachments even when the clipboard also contains text. Other pasted files become attachments only when the clipboard contains no text. `filter-files` receives the raw files before ViteHub converts them to AI SDK file parts. Return the accepted files in their desired order, or return `[]` to reject the batch.
