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

## Usage

```vue
<template>
  <Attachment state="uploading">
    <AttachmentMedia>
      <UIcon name="i-ph-image-light" />
    </AttachmentMedia>
    <AttachmentContent>
      <AttachmentTitle>screenshot.png</AttachmentTitle>
      <AttachmentDescription>Uploading · 64%</AttachmentDescription>
    </AttachmentContent>
    <AttachmentActions>
      <AttachmentAction icon="i-ph-x-light" aria-label="Cancel the upload" />
    </AttachmentActions>
  </Attachment>
</template>
```

Use `AttachmentMedia variant="image"` with an `img` for a thumbnail. Put several attachments in an `AttachmentGroup` to scroll them horizontally. Add an `AttachmentTrigger` to make the whole attachment open the file:

```vue
<Attachment>
  <AttachmentTrigger :as="NuxtLink" :to="file.url" :aria-label="`Open ${file.name}`" />
  <AttachmentContent>
    <AttachmentTitle>{{ file.name }}</AttachmentTitle>
  </AttachmentContent>
</Attachment>
```

[`useAgentAttachments()`](/docs/ui/attachments) validates and converts the files that these parts display.

## API reference

### Attachment

#### Props

| Prop          | Type                                                         | Default        | Description                                       |
| ------------- | ------------------------------------------------------------ | -------------- | ------------------------------------------------- |
| `state`       | `"idle" \| "uploading" \| "processing" \| "error" \| "done"` | `"done"`       | The upload state. Sets the border and the colors. |
| `size`        | `"default" \| "sm" \| "xs"`                                  | `"default"`    | The size of the attachment.                       |
| `orientation` | `"horizontal" \| "vertical"`                                 | `"horizontal"` | Puts the media beside or above the content.       |

### AttachmentMedia

| Prop      | Type                | Default  | Description                                    |
| --------- | ------------------- | -------- | ---------------------------------------------- |
| `variant` | `"icon" \| "image"` | `"icon"` | Whether the media holds an icon or an `img`.   |

### AttachmentTrigger

| Prop | Type                  | Default    | Description                                             |
| ---- | --------------------- | ---------- | ------------------------------------------------------- |
| `as` | `string \| Component` | `"button"` | Renders the trigger as another element, such as a link. |

### AttachmentAction

A Nuxt UI `UButton` with `color="neutral"`, `variant="ghost"`, `size="xs"`, and `square`. Other attributes, such as `icon` and `aria-label`, go to the button.

`AttachmentGroup`, `AttachmentContent`, `AttachmentTitle`, `AttachmentDescription`, and `AttachmentActions` have no props.

## Accessibility

- Give `AttachmentTrigger` and every icon-only `AttachmentAction` an `aria-label` that names the file.
- Write the state in `AttachmentDescription`, for example "Uploading · 64%". The border and colors are not the only signal.
- `AttachmentGroup` scrolls horizontally. Keep the attachments focusable through their triggers or actions.

## Related

- [Attachments](/docs/ui/attachments) validates files and converts them to AI SDK file parts.
- [Chat prompt](/docs/ui/chat-prompt) attaches files to a message.
