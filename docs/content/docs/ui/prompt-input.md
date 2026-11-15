---
title: Prompt Input
description: Collect prompt text and file attachments with a submit control that follows the AI SDK chat status.
navigation.order: 24
navigation.group: Chat
icon: i-lucide-send
---

`PromptInput` is a chat input with attachments, like the [shadcn/ui Prompt Input](https://ui.shadcn.com/docs/ai-elements/base/prompt-input). It has a textarea that grows with its text, [Attachment](/docs/ui/attachment) parts above it, and round attach and send buttons below it. The send button follows the AI SDK chat status: Send, Stop, or Retry. ViteHub adds file paste and one `submit` payload with the text and AI SDK file parts.

::example{name="ChatPromptExample" height=8}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui`. The `PromptInputSubmit` type comes from `@vite-hub/ui`:

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

The root is a `<form>`. Each slot replaces one area. Use the `data-slot` attributes for styles.

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

- `v-model` for the draft and `v-model:files` for AI SDK `FileUIPart` attachments.
- The submit button follows the AI SDK `ChatStatus`.
- One `submit` payload with the trimmed text and files.
- Files from the file picker or clipboard paste.
- `filter-files` filters raw files before conversion.

## Keyboard

Enter sends. Shift+Enter adds a line. Text from an input method never sends. Enter does not trigger Stop or Retry.

On a touch-only device, such as a phone, there is no Shift+Enter, so Enter adds a line and the Send button sends. The textarea's `enterkeyhint` is `send` with a mouse or trackpad and `enter` on touch-only devices. Toolbar buttons have a 48px touch target around their 32px circle.

## Attachments

The file picker and paste use the same path. A pasted image always becomes an attachment. Other pasted files do only when the clipboard has no text. Set `multiple` to `false` to keep one file. A new file then replaces it.

## Submission Rules

- `submit` fires only when `status` is `ready`, there is text or a file, and all attachments are converted. Enter, form submission, and the Send button use the same rule.
- You can edit the draft while a response streams or files convert.
- The component does not clear the draft. Clear `input` and `files` after a successful send.
- A failed attachment conversion emits `error` and keeps the draft and attachments.
- Unmount the prompt when the user changes session, so a pending file read cannot update the new one. A `:key` with the session ID does this.

## Status

The submit button shows Send in `ready`, Stop in `submitted` and `streaming`, and Retry in `error`. Change the status to see the button and event.

::example{name="ChatPromptStatusExample" height=12}
::

## Custom Submit Button

The `submit` slot receives `{ status, canSubmit, preparingFiles }`. Disable your button with `canSubmit` and show progress with `preparingFiles`.

::example{name="ChatPromptCustomSubmitExample" height=8}
::

## Filter Files

`filter-files` receives each batch of raw `File` objects before conversion. Return the files to keep, in order, or `[]` to reject the batch. This example rejects files over 200 KB.

::example{name="ChatPromptFilterFilesExample" height=8}
::

## Model Picker

Use the `footer-leading` slot for a model or profile picker. It sits between the attachment and submit buttons.

```vue
<PromptInput v-model="input" :status @submit="submit">
  <template #footer-leading>
    <USelect v-model="model" :items="models" aria-label="Model" size="xs" variant="ghost" />
  </template>
</PromptInput>
```

## Accessibility

- The input is named **Message**. Pass `aria-label` to change it.
- The attachment button is named **Add attachment**. Each attachment has a **Remove** button with the file name.
- The submit button is named **Send prompt**, **Stop response**, or **Retry prompt**, based on `status`. `submitLabel` renames it in `ready`. The [comment composer](/docs/ui/comments) uses it for **Comment**, **Reply**, or **Save**.
- Give custom buttons in the `actions` and `submit` slots their own accessible names.

## API Reference

### PromptInput

Renders a `<form>` with a textarea, attachments, and attach and submit buttons.

#### Props

| Prop          | Type                                           | Default   | Description                                                      |
| ------------- | ---------------------------------------------- | --------- | ---------------------------------------------------------------- |
| `modelValue`  | `string`                                       | `""`      | The draft text. Use `v-model`.                                   |
| `attachments` | `boolean`                                      | `true`    | Enables the attachment picker and handling. |
| `attachVariant` | `"outline" \| "ghost"`                       | `"outline"` | The attach button's look. `ghost` is a muted icon, for a box that has its own frame. |
| `files`       | `readonly FileUIPart[]`                        | `[]`      | The attached files. Use `v-model:files`.                         |
| `filesDisabled` | `boolean`                                     | `false`   | Disables adding and removing files. Text stays editable. |
| `status`      | `ChatStatus`                                   | `"ready"` | AI SDK chat status. Controls the submit button and rule. |
| `accept`      | `string`                                       |           | File types for the picker, in `<input accept>` format. |
| `multiple`    | `boolean`                                      | `true`    | Allows more than one attachment. When `false`, a new file replaces the current one. |
| `filterFiles` | `(files: readonly File[]) => readonly File[]`  |           | Filters each batch of raw files before conversion. |
| `placeholder` | `string`                                       |           | Placeholder text of the input.                                   |
| `submitLabel` | `string`                                       | | Submit button name in `ready`. Falls back to `"Send prompt"`. |

Other attributes go to the root `<form>`.

#### Events

| Event               | Payload                 | Description                                                    |
| ------------------- | ----------------------- | -------------------------------------------------------------- |
| `submit`            | `PromptInputSubmit`     | `{ text, files }`. Text is trimmed and may be empty when files exist. |
| `update:modelValue` | `string`                | The draft text changed.                                        |
| `update:files`      | `readonly FileUIPart[]` | Files were added or removed.                                   |
| `stop`              |                         | Stop was selected. Connect it to the AI SDK `stop()`. |
| `reload`            |                         | Retry was selected. Connect it to the AI SDK `regenerate()`. |
| `error`             | `unknown`               | A file could not be read or converted.                         |

#### Slots

| Slot             | Scope                                   | Description                                         |
| ---------------- | --------------------------------------- | --------------------------------------------------- |
| `files`          | `{ files, remove }`                     | Replaces the attachment row. Call `remove(index)` to remove a file. |
| `footer-leading` |                                         | Controls after the attachment button, such as a model picker. |
| `actions`        |                                         | Replaces the attachment button.                     |
| `submit`         | `{ status, canSubmit, preparingFiles }` | Replaces the submit button.                         |

#### Types

```ts
import type { FileUIPart } from "ai"

interface PromptInputSubmit {
  files: readonly FileUIPart[];
  text: string;
}
```

## Related

- [Attachments](/docs/ui/attachments) validates raw files before you convert them.
- [Chat](/docs/ui/chat) renders the conversation above the prompt.
- [Chat app block](/docs/ui/blocks/chat-app) shows the prompt with sessions and attachments.
