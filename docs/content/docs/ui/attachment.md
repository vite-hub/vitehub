---
title: Attachment
description: "Show a file with its upload state as a row or a tile, with an image preview, actions, sizes, and attachment groups."
navigation.order: 13
navigation.group: Parts
icon: i-lucide-paperclip
---

`Attachment` shows one file: an icon or image, a title, a description, and actions. The `status` prop shows if the file is waiting, uploading, processing, done, or failed. The parts match the names and `data-slot` attributes of the [shadcn/ui Attachment](https://ui.shadcn.com/docs/components/attachment).

::example{name="AttachmentExample" height=20}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the parts. In Vue with Vite, import them from `vite-hub/ui`:

```ts
import { Attachment, AttachmentMedia, AttachmentContent, AttachmentTitle } from "vite-hub/ui";
```

## Usage

```ts
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "vite-hub/ui";
```

```vue
<script setup lang="ts">
const open = ref(false);
</script>

<template>
  <Attachment>
    <AttachmentMedia>
      <UIcon name="i-lucide-file-text" />
    </AttachmentMedia>
    <AttachmentContent>
      <AttachmentTitle>sales-dashboard.pdf</AttachmentTitle>
      <AttachmentDescription>PDF · 2.4 MB</AttachmentDescription>
    </AttachmentContent>
    <AttachmentActions>
      <AttachmentAction label="Remove sales-dashboard.pdf" />
    </AttachmentActions>
  </Attachment>
</template>
```

[`useAgentAttachments()`](/docs/ui/attachments) validates and converts the files these parts show.

## Composition

```text
Attachment
├── AttachmentMedia
├── AttachmentContent
│   ├── AttachmentTitle
│   └── AttachmentDescription
├── AttachmentActions
│   └── AttachmentAction
└── AttachmentTrigger
```

`AttachmentGroup` puts several attachments in a scrolling row:

```text
AttachmentGroup
├── Attachment
└── Attachment
```

## Features

- Icon or image media.
- Five upload states: `idle`, `uploading`, `processing`, `error`, and `done`.
- Three sizes, and horizontal or vertical orientation.
- `AttachmentTrigger` makes the whole attachment open a link or dialog. Actions stay clickable.
- `AttachmentGroup` scrolls horizontally and snaps to each attachment.
- `AttachmentAction` is a small icon button. It shows an X; its default slot replaces the icon.

## Image

Set `kind="image"` on `AttachmentMedia` and put an `img` in it. `orientation="vertical"` puts the media above the content, with the actions in its top right corner.

::example{name="AttachmentImageExample" height=11}
::

## States

Set `status` to show upload progress. `idle` uses a dashed border. `error` colors the border, media, and description. An image dims while `uploading`, `processing`, or `error`.

::example{name="AttachmentStatesExample" height=21}
::

shadcn/ui animates the title with a shimmer while `uploading` or `processing`. ViteHub uses no continuous animations, so write the state in `AttachmentDescription`, such as "Uploading · 64%".

## Sizes

Set `size` to `md`, `sm`, or `xs`.

::example{name="AttachmentSizesExample" height=11}
::

## Group

An `AttachmentGroup` shows attachments in a row that scrolls horizontally and snaps to each one. It hides its scrollbar.

::example{name="AttachmentGroupExample" height=8}
::

## Trigger

Add an `AttachmentTrigger` to make the whole attachment open a link or dialog. It sits behind the actions, so they stay clickable. For a link, render an `a` or a `NuxtLink` in its `render` slot and bind `props` to it. For a dialog, set its open state from `@click`.

::example{name="AttachmentTriggerExample" height=8}
::

```vue
<script setup lang="ts">
const open = ref(false);
</script>

<template>
  <Attachment>
    <!-- media, content, actions -->
    <AttachmentTrigger aria-label="Preview research-summary.pdf" @click="open = true" />
  </Attachment>
  <UModal v-model:open="open" title="research-summary.pdf" />
</template>
```

## Accessibility

`AttachmentAction` renders a native `button`. `AttachmentTrigger` renders a native `button` with `type="button"`, or the element of its `render` slot.

### Label icon-only actions

`AttachmentAction` shows only an icon. Its `label` is its accessible name, "Remove" by default. Give each one a `label` that names the action and file.

```vue
<AttachmentAction label="Remove sales-dashboard.pdf" />
```

### Label the trigger

`AttachmentTrigger` has no text. Give it an `aria-label` that says what it does.

```vue
<AttachmentTrigger>
  <template #render="{ props }">
    <a v-bind="props" :href="file.url" target="_blank" rel="noreferrer" :aria-label="`Open ${file.name}`" />
  </template>
</AttachmentTrigger>
```

Users can focus and click each action and the trigger separately.

### Keyboard scrolling

When attachments have a trigger or actions, keyboard users reach off-screen ones with Tab. For a row with no controls, add `tabindex="0"`, `role="group"`, and an `aria-label` to the `AttachmentGroup` so keyboard users can scroll it.

### Meaning beyond color

Do not rely on the `error` color alone. Write the state in `AttachmentDescription`, such as "Upload failed. Try again."

## API Reference

### Attachment

Renders a `div` with `data-slot="attachment"`, `data-status`, `data-size`, and `data-orientation`.

#### Props

| Prop          | Type                                                         | Default        | Description                                       |
| ------------- | ------------------------------------------------------------ | -------------- | ------------------------------------------------- |
| `status`      | `"idle" \| "uploading" \| "processing" \| "error" \| "done"` | `"done"`       | The upload state. Sets the border and colors. |
| `size`        | `"md" \| "sm" \| "xs"`                                       | `"md"`         | The attachment size. |
| `orientation` | `"horizontal" \| "vertical"`                                 | `"horizontal"` | Puts the media beside or above the content.       |

### AttachmentMedia

The icon or image preview. Renders a `div` with `data-slot="attachment-media"` and `data-kind`.

#### Props

| Prop   | Type                | Default  | Description          |
| ------ | ------------------- | -------- | -------------------- |
| `kind` | `"icon" \| "image"` | `"icon"` | An icon or an `img`. |

### AttachmentContent

Holds the title and description. No props. Renders a `div` with `data-slot="attachment-content"`.

### AttachmentTitle

The file name. No props. Renders a `span` with `data-slot="attachment-title"`. Long names end with an ellipsis.

### AttachmentDescription

The file type, size, or upload state. No props. Renders a `span` with `data-slot="attachment-description"`.

### AttachmentActions

Actions at the end of the attachment. No props. Renders a `div` with `data-slot="attachment-actions"`.

### AttachmentAction

One icon button. Renders a `button` with `data-slot="attachment-action"`. Other attributes, such as `@click`, go to the button. The default slot replaces the X icon.

#### Props

| Prop       | Type      | Default    | Description |
| ---------- | --------- | ---------- | ----------- |
| `label`    | `string`  | `"Remove"` | The accessible name of the button. |
| `disabled` | `boolean` | `false`    | Disables the button. |

### AttachmentTrigger

Covers the attachment, so a click anywhere opens the file. Renders a `button` with `type="button"`.

#### Slots

| Slot     | Scope                 | Description |
| -------- | --------------------- | ----------- |
| `render` | `{ props, children }` | Renders your own element, such as a link. Bind `props` to it. |

### AttachmentGroup

A row that scrolls horizontally and snaps to each attachment. No props. Renders a `div` with `data-slot="attachment-group"`.

## Related

- [Attachments](/docs/ui/attachments) validates files and converts them to AI SDK file parts.
- [Prompt input](/docs/ui/prompt-input) attaches files to a message.
