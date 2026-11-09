---
title: Attachment
description: "Show a file with its upload state as a row or a tile, with an image preview, actions, sizes, and attachment groups."
navigation.order: 13
navigation.group: Parts
icon: i-lucide-paperclip
---

`Attachment` shows one file: an icon or image, a title, a description, and actions. The `state` prop shows if the file is waiting, uploading, processing, done, or failed. The parts match the names, props, and `data-slot` attributes of the [shadcn/ui Attachment](https://ui.shadcn.com/docs/components/attachment).

::example{name="AttachmentExample" height=20}
::

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui`:

```ts
import { Attachment, AttachmentMedia, AttachmentContent, AttachmentTitle } from "@vite-hub/ui";
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
} from "@vite-hub/ui";
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
      <AttachmentAction icon="i-lucide-x" aria-label="Remove sales-dashboard.pdf" />
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
- `AttachmentAction` is a Nuxt UI `UButton`, so it takes `icon`, `aria-label`, and other `UButton` props.

## Image

Set `variant="image"` on `AttachmentMedia` and put an `img` in it. `orientation="vertical"` puts the media above the content, with the actions in its top right corner.

::example{name="AttachmentImageExample" height=11}
::

## States

Set `state` to show upload progress. `idle` uses a dashed border. `error` colors the border, media, and description. An image dims while `uploading`, `processing`, or `error`.

::example{name="AttachmentStatesExample" height=21}
::

shadcn/ui animates the title with a shimmer while `uploading` or `processing`. ViteHub uses no continuous animations, so write the state in `AttachmentDescription`, such as "Uploading · 64%".

## Sizes

Set `size` to `default`, `sm`, or `xs`.

::example{name="AttachmentSizesExample" height=11}
::

## Group

An `AttachmentGroup` shows attachments in a row that scrolls horizontally and snaps to each one. It hides its scrollbar.

::example{name="AttachmentGroupExample" height=8}
::

## Trigger

Add an `AttachmentTrigger` to make the whole attachment open a link or dialog. It sits behind the actions, so they stay clickable. For a link, use `as="a"` with `href`, or `:as="NuxtLink"` with `to`. For a dialog, set its open state from `@click`.

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

`AttachmentAction` renders a Nuxt UI `UButton`. `AttachmentTrigger` renders a native `button` with `type="button"`, or the element you set with `as`.

### Label icon-only actions

`AttachmentAction` usually shows only an icon. Give each one an `aria-label` that names the action and file.

```vue
<AttachmentAction icon="i-lucide-x" aria-label="Remove sales-dashboard.pdf" />
```

### Label the trigger

`AttachmentTrigger` has no text. Give it an `aria-label` that says what it does.

```vue
<AttachmentTrigger as="a" :href="file.url" target="_blank" rel="noreferrer" :aria-label="`Open ${file.name}`" />
```

Users can focus and click each action and the trigger separately.

### Keyboard scrolling

When attachments have a trigger or actions, keyboard users reach off-screen ones with Tab. For a row with no controls, add `tabindex="0"`, `role="group"`, and an `aria-label` to the `AttachmentGroup` so keyboard users can scroll it.

### Meaning beyond color

Do not rely on the `error` color alone. Write the state in `AttachmentDescription`, such as "Upload failed. Try again."

## API Reference

### Attachment

Renders a `div` with `data-slot="attachment"`, `data-state`, `data-size`, and `data-orientation`.

#### Props

| Prop          | Type                                                         | Default        | Description                                       |
| ------------- | ------------------------------------------------------------ | -------------- | ------------------------------------------------- |
| `state`       | `"idle" \| "uploading" \| "processing" \| "error" \| "done"` | `"done"`       | The upload state. Sets the border and colors. |
| `size`        | `"default" \| "sm" \| "xs"`                                  | `"default"`    | The attachment size. |
| `orientation` | `"horizontal" \| "vertical"`                                 | `"horizontal"` | Puts the media beside or above the content.       |

### AttachmentMedia

The icon or image preview. Renders a `div` with `data-slot="attachment-media"`.

#### Props

| Prop      | Type                | Default  | Description                                  |
| --------- | ------------------- | -------- | -------------------------------------------- |
| `variant` | `"icon" \| "image"` | `"icon"` | An icon or an `img`. |

### AttachmentContent

Holds the title and description. No props. Renders a `div` with `data-slot="attachment-content"`.

### AttachmentTitle

The file name. No props. Renders a `span` with `data-slot="attachment-title"`. Long names end with an ellipsis.

### AttachmentDescription

The file type, size, or upload state. No props. Renders a `span` with `data-slot="attachment-description"`.

### AttachmentActions

Actions at the end of the attachment. No props. Renders a `div` with `data-slot="attachment-actions"`.

### AttachmentAction

One action button. No props of its own. Renders a Nuxt UI `UButton` with `color="neutral"`, `variant="ghost"`, `size="xs"`, and `square`. Other attributes, such as `icon`, `aria-label`, and `@click`, go to the button.

### AttachmentTrigger

Covers the attachment, so a click anywhere opens the file. Renders a `button` with `type="button"`. Your own `type` attribute overrides it.

#### Props

| Prop | Type                  | Default    | Description                                             |
| ---- | --------------------- | ---------- | ------------------------------------------------------- |
| `as` | `string \| Component` | `"button"` | Renders the trigger as another element, such as a link. |

### AttachmentGroup

A row that scrolls horizontally and snaps to each attachment. No props. Renders a `div` with `data-slot="attachment-group"`.

## Related

- [Attachments](/docs/ui/attachments) validates files and converts them to AI SDK file parts.
- [Prompt input](/docs/ui/prompt-input) attaches files to a message.
