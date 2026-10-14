---
title: Prompt Input
description: Collect prompt text and file attachments with a submit control that follows the AI SDK chat status.
navigation.order: 24
navigation.group: Chat
icon: i-ph-paper-plane-tilt-light
---

`PromptInput` is a chat input with attachments, built like the [shadcn/ui Prompt Input](https://ui.shadcn.com/docs/ai-elements/base/prompt-input): a framed textarea that grows with its content, attachments above it as [Attachment](/docs/ui/attachment) parts, and round attach and send buttons below it. Enter sends and Shift+Enter adds a line; text composed with an input method never sends. The send button follows the AI SDK chat status: Send, Stop, or Retry. ViteHub adds clipboard paste for files and one `submit` payload with text and AI SDK file parts.

::component-preview{name="ChatPromptExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/prompt-input`. The `PromptInputSubmit` type comes from `@vite-hub/ui`:

```ts
import { PromptInput, type PromptInputSubmit } from "@vite-hub/ui";
```

## Usage

```ts
import { PromptInput } from "@vite-hub/ui";
```

```vue
<PromptInput
  v-model="input"
  v-model:files="files"
  accept="image/*,.pdf"
  :status
  @submit="({ text, files }) => sendMessage({ text, files: [...files] })"
  @reload="regenerate"
  @stop="stop"
/>
```

## Composition

The root is a `<form>`. Each slot replaces one area. The `data-slot` attributes name the areas for styles.

```text
PromptInput (form, data-slot="prompt-input")
└── prompt-input-group
    ├── AttachmentGroup, or the files slot
    │   └── Attachment, one for each file
    ├── prompt-input-textarea
    └── prompt-input-toolbar
        ├── attach button, or the actions slot
        ├── footer-leading slot
        └── submit button, or the submit slot
```

## Features

- Uses `v-model` for the draft and `v-model:files` for AI SDK `FileUIPart` attachments.
- Changes the submit button with the AI SDK `ChatStatus`: Send, Stop, or Retry.
- Emits one `submit` payload with the trimmed text and the files.
- Adds files from the file picker or from clipboard paste.
- Filters raw files before conversion with `filter-files`.
- Does not clear the draft. Your application clears it after a successful send.

## Keyboard

Enter sends the message. Shift+Enter adds a new line. Text composed with an input method never sends. Enter does not trigger Stop or Retry.

## Attachments

The file picker and clipboard paste use the same path. A pasted image always becomes an attachment. Other pasted files become attachments only when the clipboard has no text. Set `multiple` to `false` to keep one file. A new file then replaces the current one.

## Submission Rules

- `submit` fires only when `status` is `ready`, the text or the files are not empty, and every attachment batch has finished conversion. Enter, form submission, and the Send button use the same rule.
- You can edit the draft while a response streams or files convert.
- Stop and Retry stay available in their states. Enter does not trigger them.
- The component does not clear the draft. Clear `input` and `files` after a successful send.
- An attachment conversion error emits `error`. It keeps the draft and the existing attachments.
- Unmount the prompt when the user changes to another session, so a pending file read cannot update that session. A `:key` with the session ID does this.

## Status

The submit button follows `status`: Send in `ready`, Stop in `submitted` and `streaming`, and Retry in `error`. Change the status and watch the button and the emitted event.

::component-preview{name="ChatPromptStatusExample"}
::

## Custom Submit Button

The `submit` slot receives `{ status, canSubmit, preparingFiles }`. Disable your button with `canSubmit` and show progress with `preparingFiles`.

::component-preview{name="ChatPromptCustomSubmitExample"}
::

## Filter Files

`filter-files` receives the raw `File` objects of a batch before conversion. Return the files to keep, in the order you want. Return `[]` to reject the batch. This example rejects files over 200 KB.

::component-preview{name="ChatPromptFilterFilesExample"}
::

## Model Picker

Use the `footer-leading` slot for a model or profile picker. It renders after the attachment button and before the submit button.

```vue
<PromptInput v-model="input" :status @submit="submit">
  <template #footer-leading>
    <USelect v-model="model" :items="models" aria-label="Model" size="xs" variant="ghost" />
  </template>
</PromptInput>
```

## Accessibility

- The input has the accessible name **Message**. Pass `aria-label` to change it.
- The attachment button is named **Add attachment**. Each attachment has a **Remove** button with the file name.
- The submit button is named **Send prompt**, **Stop response**, or **Retry prompt**, based on `status`.
- Give custom buttons in the `actions` and `submit` slots their own accessible names.

## API Reference

### PromptInput

Renders a `<form>` with a textarea, the attachments, and the attach and submit buttons.

#### Props

| Prop          | Type                                           | Default   | Description                                                      |
| ------------- | ---------------------------------------------- | --------- | ---------------------------------------------------------------- |
| `modelValue`  | `string`                                       | `""`      | The draft text. Use `v-model`.                                   |
| `files`       | `readonly FileUIPart[]`                        | `[]`      | The attached files. Use `v-model:files`.                         |
| `status`      | `ChatStatus`                                   | `"ready"` | AI SDK chat status. Controls the submit button and the submit rule. |
| `accept`      | `string`                                       |           | Accepted file types for the picker, in `<input accept>` format.  |
| `multiple`    | `boolean`                                      | `true`    | Allows more than one attachment. When `false`, a new file replaces the current one. |
| `filterFiles` | `(files: readonly File[]) => readonly File[]`  |           | Filters each batch of raw files before conversion.               |
| `placeholder` | `string`                                       |           | Placeholder text of the input.                                   |

Other attributes go to the root `<form>`.

#### Events

| Event               | Payload                 | Description                                                    |
| ------------------- | ----------------------- | -------------------------------------------------------------- |
| `submit`            | `PromptInputSubmit`     | `{ text, files }`. The text is trimmed. Empty text is allowed when files exist. |
| `update:modelValue` | `string`                | The draft text changed.                                        |
| `update:files`      | `readonly FileUIPart[]` | Files were added or removed.                                   |
| `stop`              |                         | The viewer selected Stop. Connect it to the AI SDK `stop()`.   |
| `reload`            |                         | The viewer selected Retry. Connect it to the AI SDK `regenerate()`. |
| `error`             | `unknown`               | A file could not be read or converted.                         |

#### Slots

| Slot             | Scope                                   | Description                                         |
| ---------------- | --------------------------------------- | --------------------------------------------------- |
| `files`          | `{ files, remove }`                     | Replaces the attachment row. Call `remove(index)` to remove a file. |
| `footer-leading` |                                         | Controls at the start of the footer, after the attachment button. Use it for a model or profile picker. |
| `actions`        |                                         | Replaces the attachment button.                     |
| `submit`         | `{ status, canSubmit, preparingFiles }` | Replaces the submit button.                         |

#### Types

```ts
interface PromptInputSubmit {
  files: readonly FileUIPart[];
  text: string;
}
```

## Related

- [Attachments](/docs/ui/attachments) validates raw files before you convert them.
- [Chat](/docs/ui/chat) renders the conversation above the prompt.
- [Chat app block](/docs/ui/blocks/chat-app) shows the prompt with sessions and attachments.
