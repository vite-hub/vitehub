---
title: Attachment
description: "Show a file with its upload state as a row or a tile with actions."
navigation.order: 13
navigation.group: Parts
icon: i-ph-paperclip-light
---

`Attachment` shows one file: an icon or an image, a title, a description, and actions. The `state` prop shows whether the file is waiting, uploading, processing, done, or failed. The parts have the same names, props, and `data-slot` attributes as the [shadcn/ui Attachment](https://ui.shadcn.com/docs/components/attachment).

::component-preview{name="AttachmentExample"}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the parts. In Vue with Vite, import them from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/attachment`:

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
<template>
  <Attachment>
    <AttachmentMedia>
      <UIcon name="i-ph-file-text-light" />
    </AttachmentMedia>
    <AttachmentContent>
      <AttachmentTitle>sales-dashboard.pdf</AttachmentTitle>
      <AttachmentDescription>PDF · 2.4 MB</AttachmentDescription>
    </AttachmentContent>
    <AttachmentActions>
      <AttachmentAction icon="i-ph-x-light" aria-label="Remove sales-dashboard.pdf" />
    </AttachmentActions>
  </Attachment>
</template>
```

[`useAgentAttachments()`](/docs/ui/attachments) validates and converts the files that these parts display.

## Composition

Use the following composition to build an attachment:

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

Use `AttachmentGroup` to put several attachments in a row that scrolls:

```text
AttachmentGroup
├── Attachment
└── Attachment
```

## Features

- Icon or image media through `AttachmentMedia`.
- Five upload states: `idle`, `uploading`, `processing`, `error`, and `done`.
- Three sizes, and a horizontal or vertical orientation.
- An `AttachmentTrigger` that makes the whole attachment open a link or a dialog. The actions stay clickable.
- An `AttachmentGroup` that scrolls horizontally and snaps to each attachment.
- `AttachmentAction` is a Nuxt UI `UButton`, so it takes `icon`, `aria-label`, and the other `UButton` props.

## Image

Set `variant="image"` on `AttachmentMedia` and put an `img` in it. Use `orientation="vertical"` to show the media above the content. In a vertical attachment, the actions go to the top right corner of the media.

::component-preview{name="AttachmentImageExample"}
::

## States

Set `state` to show the upload lifecycle. `idle` uses a dashed border. `error` uses the error color for the border, the media, and the description. An image dims while the state is `uploading`, `processing`, or `error`.

::component-preview{name="AttachmentStatesExample"}
::

shadcn/ui animates the title with a shimmer while the file is `uploading` or `processing`. ViteHub does not use continuous animations, so write the state in `AttachmentDescription`, for example "Uploading · 64%".

## Sizes

Use `size` to select `default`, `sm`, or `xs`.

::component-preview{name="AttachmentSizesExample"}
::

## Group

Put attachments in an `AttachmentGroup` to show them in a row that scrolls horizontally and snaps to each attachment. The group hides its scrollbar.

::component-preview{name="AttachmentGroupExample"}
::

## Trigger

Add an `AttachmentTrigger` to make the whole attachment open a link or a dialog. It covers the attachment behind the actions, so the actions stay clickable. Use `as` to render it as a link, for example `as="a"` with `href`, or `:as="NuxtLink"` with `to`. To open a dialog, set the open state of the dialog from `@click`.

::component-preview{name="AttachmentTriggerExample"}
::

```vue
<template>
  <Attachment>
    <!-- media, content, actions -->
    <AttachmentTrigger aria-label="Preview research-summary.pdf" @click="open = true" />
  </Attachment>
  <UModal v-model:open="open" title="research-summary.pdf" />
</template>
```

## Accessibility

`AttachmentAction` renders a Nuxt UI `UButton`. `AttachmentTrigger` renders a native `button` with `type="button"`, or the element that you set with `as`.

### Label icon-only actions

`AttachmentAction` usually shows only an icon. Give each action an `aria-label` that names the action and the file.

```vue
<AttachmentAction icon="i-ph-x-light" aria-label="Remove sales-dashboard.pdf" />
```

### Label the trigger

`AttachmentTrigger` covers the attachment and has no text. Give it an `aria-label` that says what it does.

```vue
<AttachmentTrigger as="a" :href="file.url" target="_blank" rel="noreferrer" :aria-label="`Open ${file.name}`" />
```

The trigger is behind the actions. Users can focus and click each action and the trigger separately.

### Keyboard scrolling

`AttachmentGroup` scrolls horizontally. When the attachments have a trigger or actions, keyboard users reach the attachments that are off screen with the Tab key. For a row of attachments with no controls, add `tabindex="0"`, `role="group"`, and an `aria-label` to the group, so that keyboard users can scroll it.

### Meaning beyond color

The `error` state uses the error color. Write the state in `AttachmentDescription`, for example "Upload failed. Try again." The border and the colors are not the only signal.

## API Reference

### Attachment

The root of one attachment. Renders a `div` with `data-slot="attachment"` and `data-state`, `data-size`, and `data-orientation` attributes.

#### Props

| Prop          | Type                                                         | Default        | Description                                       |
| ------------- | ------------------------------------------------------------ | -------------- | ------------------------------------------------- |
| `state`       | `"idle" \| "uploading" \| "processing" \| "error" \| "done"` | `"done"`       | The upload state. Sets the border and the colors. |
| `size`        | `"default" \| "sm" \| "xs"`                                  | `"default"`    | The size of the attachment.                       |
| `orientation` | `"horizontal" \| "vertical"`                                 | `"horizontal"` | Puts the media beside or above the content.       |

### AttachmentMedia

The icon or the image preview. Renders a `div` with `data-slot="attachment-media"`.

#### Props

| Prop      | Type                | Default  | Description                                  |
| --------- | ------------------- | -------- | -------------------------------------------- |
| `variant` | `"icon" \| "image"` | `"icon"` | Whether the media holds an icon or an `img`. |

### AttachmentContent

Holds the title and the description. Has no props. Renders a `div` with `data-slot="attachment-content"`.

### AttachmentTitle

The file name. Has no props. Renders a `span` with `data-slot="attachment-title"`. A long name ends with an ellipsis.

### AttachmentDescription

The file type, the size, or the upload state. Has no props. Renders a `span` with `data-slot="attachment-description"`.

### AttachmentActions

Holds one or more actions at the end of the attachment. Has no props. Renders a `div` with `data-slot="attachment-actions"`.

### AttachmentAction

One action button. Has no props of its own. Renders a Nuxt UI `UButton` with `color="neutral"`, `variant="ghost"`, `size="xs"`, and `square`. Other attributes, such as `icon`, `aria-label`, and `@click`, go to the button.

### AttachmentTrigger

Covers the whole attachment so that a click on any part of it opens the file. Renders a `button` with `type="button"` by default. A `type` attribute that you set overrides it.

#### Props

| Prop | Type                  | Default    | Description                                             |
| ---- | --------------------- | ---------- | ------------------------------------------------------- |
| `as` | `string \| Component` | `"button"` | Renders the trigger as another element, such as a link. |

### AttachmentGroup

Puts attachments in a row that scrolls horizontally and snaps to each attachment. Has no props. Renders a `div` with `data-slot="attachment-group"`.

## Related

- [Attachments](/docs/ui/attachments) validates files and converts them to AI SDK file parts.
- [Prompt input](/docs/ui/prompt-input) attaches files to a message.
