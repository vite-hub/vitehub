---
title: Prompt Input
description: Collect prompt text and file attachments with a submit control that follows the AI SDK chat status.
navigation.order: 24
navigation.group: Chat
icon: i-lucide-send
---

`PromptInput` is a chat input with attachments, like the [shadcn/ui Prompt Input](https://ui.shadcn.com/docs/ai-elements/base/prompt-input). It has a textarea that grows with its text, [Attachment](/docs/ui/attachment) parts above it, and round attach and send buttons below it. Each area is a part, so you can leave one out or put your own control in. The send button follows the AI SDK chat status: Send, Stop, or Retry. ViteHub adds file paste and one `submit` payload with the text and AI SDK file parts.

::example{name="ChatPromptExample" height=8}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the parts. In Vue with Vite, import them from `vite-hub/ui`:

```ts
import { PromptInput, PromptInputAttach, PromptInputAttachments, PromptInputSubmit, PromptInputTextarea, PromptInputToolbar, type PromptInputSubmitEvent } from "vite-hub/ui";
```

To own the source, add the item with shadcn-vue. It installs to `components/vitehub/prompt-input/`:

```bash
npx shadcn-vue@latest add https://vitehub.dev/r/prompt-input.json
```

## Usage

```vue
<PromptInput
  v-model="input"
  v-model:files="files"
  accept="image/*,.pdf"
  :status
  @submit="({ text, files }) => sendMessage({ text, files: [...files] })"
  @retry="regenerate"
  @stop="stop"
/>
```

Without children, `PromptInput` renders the default parts. Pass children to choose the parts:

```vue
<PromptInput v-model="input" :status @submit="submit">
  <PromptInputAttachments />
  <PromptInputTextarea />
  <PromptInputToolbar>
    <PromptInputAttach />
    <PromptInputSubmit />
  </PromptInputToolbar>
</PromptInput>
```

## Composition

The root is a `<form>`. Use the `data-slot` attributes for styles.

```text
PromptInput (form, data-slot="prompt-input")
└── prompt-input-group
    ├── PromptInputAttachments (prompt-input-attachments), an Attachment for each file
    ├── PromptInputTextarea (prompt-input-textarea)
    └── PromptInputToolbar (prompt-input-toolbar)
        ├── PromptInputAttach (prompt-input-attach)
        └── PromptInputSubmit (prompt-input-spacer, prompt-input-submit)
```

## Features

- `v-model` for the draft and `v-model:files` for AI SDK `FileUIPart` attachments. Without `v-model`, `defaultValue` and `defaultFiles` set the first values.
- The submit button follows the AI SDK `ChatStatus`.
- One `submit` payload with the trimmed text and files.
- Files from the file picker or clipboard paste.
- `filter-files` filters raw files before conversion.

## Keyboard

Enter sends. Shift+Enter adds a line. Text from an input method never sends. Enter does not trigger Stop or Retry.

On a touch-only device, such as a phone, there is no Shift+Enter, so Enter adds a line and the Send button sends. The textarea's `enterkeyhint` is `send` with a mouse or trackpad and `enter` on touch-only devices. Toolbar buttons have a 48px touch target around their circle.

## Attachments

The file picker and paste use the same path. A pasted image always becomes an attachment. Other pasted files do only when the clipboard has no text. Set `single` to keep one file. A new file then replaces it.

Leave out `PromptInputAttach` for a prompt without files. Then a paste adds no files either.

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

The default slot of `PromptInput` receives `{ status, canSubmit, preparing }`. Put your own button in the toolbar instead of `PromptInputSubmit`. Disable it with `canSubmit` and show progress with `preparing`.

::example{name="ChatPromptCustomSubmitExample" height=8}
::

## Filter Files

`filter-files` receives each batch of raw `File` objects before conversion. Return the files to keep, in order, or `[]` to reject the batch. This example rejects files over 200 KB.

::example{name="ChatPromptFilterFilesExample" height=8}
::

## Model Picker

Put a model or profile picker in the toolbar, between the attach and submit buttons.

```vue
<PromptInput v-model="input" :status @submit="submit">
  <PromptInputAttachments />
  <PromptInputTextarea />
  <PromptInputToolbar>
    <PromptInputAttach />
    <USelect v-model="model" :items="models" aria-label="Model" size="xs" variant="ghost" />
    <PromptInputSubmit />
  </PromptInputToolbar>
</PromptInput>
```

## Accessibility

- The input is named **Message**. Pass `aria-label` to change it.
- The attachment button is named **Add attachment**. Its `label` prop renames it. Each attachment has a **Remove** button with the file name.
- The submit button is named **Send prompt**, **Stop response**, or **Retry prompt**, based on `status`. `submitLabel` renames it in `ready`. The [comment composer](/docs/ui/comments) uses it for **Comment**, **Reply**, or **Save**.
- Give your own buttons in the toolbar their own accessible names.

## API Reference

### PromptInput

Renders a `<form>` and gives its parts the draft, the files, and the status.

#### Props

| Prop           | Type                                          | Default   | Description |
| -------------- | --------------------------------------------- | --------- | ----------- |
| `modelValue`   | `string`                                      |           | The draft text. Use `v-model`. |
| `defaultValue` | `string`                                      | `""`      | The first draft when there is no `v-model`. |
| `files`        | `readonly FileUIPart[]`                       |           | The attached files. Use `v-model:files`. |
| `defaultFiles` | `readonly FileUIPart[]`                       | `[]`      | The first files when there is no `v-model:files`. |
| `status`       | `ChatStatus`                                  | `"ready"` | AI SDK chat status. Controls the submit button and rule. |
| `accept`       | `string`                                      |           | File types for the picker, in `<input accept>` format. |
| `single`       | `boolean`                                     | `false`   | Keeps one file. A new file replaces the current one. |
| `filterFiles`  | `(files: readonly File[]) => readonly File[]` |           | Filters each batch of raw files before conversion. |
| `disabled`     | `boolean`                                     | `false`   | The prompt takes no input, such as when the user has no questions left. The field, the attach button, Send, and Retry are disabled. Stop stays pressable. |
| `readonly`     | `boolean`                                     | `false`   | The text is being sent: the field is read-only, Enter does nothing, and Send shows a spinner. |
| `placeholder`  | `string`                                      |           | Placeholder text of the input. |
| `submitLabel`  | `string`                                      |           | Submit button name in `ready`. Falls back to `"Send prompt"`. |

Other attributes go to the root `<form>`.

#### Events

| Event               | Payload                  | Description |
| ------------------- | ------------------------ | ----------- |
| `submit`            | `PromptInputSubmitEvent` | `{ text, files }`. Text is trimmed and may be empty when files exist. |
| `update:modelValue` | `string`                 | The draft text changed. |
| `update:files`      | `readonly FileUIPart[]`  | Files were added or removed. |
| `stop`              |                          | Stop was selected. Connect it to the AI SDK `stop()`. |
| `retry`             |                          | Retry was selected. Connect it to the AI SDK `regenerate()`. |
| `error`             | `{ error: unknown }`     | A file could not be read or converted. |

#### Slots

| Slot      | Scope                              | Description |
| --------- | ---------------------------------- | ----------- |
| `default` | `{ status, canSubmit, preparing }` | The parts. Without it, the default parts render. |

### PromptInputAttach

The attach button and its hidden file input.

| Prop       | Type                   | Default            | Description |
| ---------- | ---------------------- | ------------------ | ----------- |
| `variant`  | `"outline" \| "ghost"` | `"outline"`        | `ghost` is a muted icon, for a box that has its own frame. |
| `disabled` | `boolean`              | `false`            | Disables adding files. Text stays editable. |
| `label`    | `string`               | `"Add attachment"` | The accessible name of the button. |

The default slot replaces the plus icon.

### PromptInputAttachments

A row of [Attachment](/docs/ui/attachment) chips, one for each file, with a Remove button each. It renders nothing without files. `disabled` turns off the Remove buttons.

### PromptInputSubmit

The Send, Stop, and Retry button. Its default slot receives `{ status, canSubmit, preparing }` and replaces the icon.

### PromptInputTextarea and PromptInputToolbar

The text field and the row of buttons under it. Other attributes go to their element.

#### Types

```ts
import type { FileUIPart } from "ai"

interface PromptInputSubmitEvent {
  files: readonly FileUIPart[];
  text: string;
}
```

## Related

- [Attachments](/docs/ui/attachments) validates raw files before you convert them.
- [Chat](/docs/ui/chat) renders the conversation above the prompt.
- [Chat app block](/docs/ui/blocks/chat-app) shows the prompt with sessions and attachments.
