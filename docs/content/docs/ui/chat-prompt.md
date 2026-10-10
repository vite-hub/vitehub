---
title: Chat Prompt
description: Collect prompt text and file attachments with a submit control that follows the AI SDK chat status.
navigation.order: 24
navigation.group: Chat
icon: i-ph-paper-plane-tilt-light
---

`AgentChatPrompt` is a chat input with attachments. It keeps Nuxt UI's `UChatPrompt` behavior: autoresize, IME handling, Enter to send, Escape to blur, and the status-aware submit button. ViteHub adds an attachment row, clipboard paste for files, and one `submit` payload with text and AI SDK file parts.

::component-preview{name="ChatPromptExample"}
::

## Usage

```vue
<AgentChatPrompt
  v-model="input"
  v-model:files="files"
  accept="image/*,.pdf"
  :status
  @submit="({ text, files }) => sendMessage({ text, files: [...files] })"
  @reload="regenerate"
  @stop="stop"
/>
```

## Submission rules

- `submit` fires only when `status` is `ready`, the text or the files are not empty, and every attachment batch has finished conversion. Enter, form submission, and the Send button use the same rule.
- You can edit the draft while a response streams or files convert.
- Stop and Retry stay available in their states. Enter does not trigger them.
- The component does not clear the draft. Clear `input` and `files` after a successful send.
- An attachment conversion error emits `error`. It keeps the draft and the existing attachments.
- Unmount the prompt when the user changes to another session, so a pending file read cannot update that session. A `:key` with the session ID does this.

The file picker and clipboard paste use the same path. A pasted image always becomes an attachment. Other pasted files become attachments only when the clipboard has no text.

## Examples

### Status

The submit button follows `status`: Send in `ready`, Stop in `submitted` and `streaming`, and Retry in `error`. Change the status and watch the button and the emitted event.

::component-preview{name="ChatPromptStatusExample"}
::

### Custom submit button

The `submit` slot receives `{ status, canSubmit, preparingFiles }`. Disable your button with `canSubmit` and show progress with `preparingFiles`.

::component-preview{name="ChatPromptCustomSubmitExample"}
::

### Filter files

`filter-files` receives the raw `File` objects of a batch before conversion. Return the files to keep, in the order you want. Return `[]` to reject the batch. This example rejects files over 200 KB.

::component-preview{name="ChatPromptFilterFilesExample"}
::

## API reference

### AgentChatPrompt

#### Props

| Prop          | Type                                           | Default   | Description                                                      |
| ------------- | ---------------------------------------------- | --------- | ---------------------------------------------------------------- |
| `modelValue`  | `string`                                       | `''`      | The draft text. Use `v-model`.                                   |
| `files`       | `readonly FileUIPart[]`                        | `[]`      | The attached files. Use `v-model:files`.                         |
| `status`      | `ChatStatus`                                   | `'ready'` | AI SDK chat status. Controls the submit button and the submit rule. |
| `accept`      | `string`                                       |           | Accepted file types for the picker, in `<input accept>` format.  |
| `multiple`    | `boolean`                                      | `true`    | Allows more than one attachment. When `false`, a new file replaces the current one. |
| `filterFiles` | `(files: readonly File[]) => readonly File[]`  |           | Filters each batch of raw files before conversion.               |
| `placeholder` | `string`                                       |           | Placeholder text of the input.                                   |

Other attributes go to `UChatPrompt`.

#### Events

| Event               | Payload                 | Description                                                    |
| ------------------- | ----------------------- | -------------------------------------------------------------- |
| `submit`            | `AgentChatPromptSubmit` | `{ text, files }`. The text is trimmed. Empty text is allowed when files exist. |
| `update:modelValue` | `string`                | The draft text changed.                                        |
| `update:files`      | `readonly FileUIPart[]` | Files were added or removed.                                   |
| `stop`              |                         | The viewer selected Stop. Connect it to the AI SDK `stop()`.   |
| `reload`            |                         | The viewer selected Retry. Connect it to the AI SDK `regenerate()`. |
| `error`             | `unknown`               | A file could not be read or converted.                         |

#### Slots

| Slot      | Scope                                    | Description                                         |
| --------- | ---------------------------------------- | --------------------------------------------------- |
| `files`   | `{ files, remove }`                      | Replaces the attachment row. Call `remove(index)` to remove a file. |
| `footer-leading` |                                   | Controls at the start of the footer, before the attachment button. Use it for a model or profile picker. |
| `actions` |                                          | Replaces the attachment button.                     |
| `submit`  | `{ status, canSubmit, preparingFiles }`  | Replaces the submit button.                         |

#### Types

```ts
interface AgentChatPromptSubmit {
  files: readonly FileUIPart[];
  text: string;
}
```

## Accessibility

- The input has the accessible name **Message**. Pass `aria-label` to change it.
- The attachment button is named **Add attachment**. Each attachment has a **Remove** button with the file name.
- The submit button is named **Send prompt**, **Stop response**, or **Retry prompt**, based on `status`.
- Give custom buttons in the `actions` and `submit` slots their own accessible names.

## Related

- [Attachments](/docs/ui/attachments) validates raw files before you convert them.
- [Chat](/docs/ui/chat) renders the conversation above the prompt.
- [Chat app block](/docs/ui/blocks/chat-app) shows the prompt with sessions and attachments.
