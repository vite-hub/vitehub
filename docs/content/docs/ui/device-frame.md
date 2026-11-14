---
title: Device Frame
description: "Show a page, an app preview, or an iframe at a phone's, a tablet's, or any size, with Chrome's device toolbar above it."
navigation.order: 45
navigation.group: Agent work
icon: i-lucide-smartphone
---

`DeviceFrame` shows its content at a device's size, after Chrome's device toolbar and Firefox's responsive mode. The page gets exactly that many CSS pixels, so its media queries see a phone. It sits centered on a muted stage and fits the pane, scaled down but never up, as in T3 Code's preview. Off, the content fills the frame.

::example{name="DeviceFrameExample" flush height=32}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). `vite-hub/nuxt` auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui`:

```ts
import { DeviceFrame } from "@vite-hub/ui";
```

## Usage

Put the page inside, and turn device mode on with `on` in the size:

```vue
<script setup lang="ts">
import type { DeviceFrameSize } from "@vite-hub/ui";

const size = ref<DeviceFrameSize>({ on: true, id: "iphone", width: 393, height: 852, zoom: null });
</script>

<template>
  <DeviceFrame v-model="size">
    <iframe src="https://example.com" title="Preview" class="size-full" />
  </DeviceFrame>
</template>
```

Without `v-model`, the frame keeps its own state; `storage-key` keeps it in local storage, and `default-value` sets the first size. A toggle elsewhere, such as a toolbar button, sets `on` in the same `v-model`. The same elements render on and off, so an iframe inside never reloads.

The bar picks a device, takes any width and height, rotates, sets the width to one of Chrome's breakpoints in a click, and zooms; **Fit** goes back to fitting the pane. The page's right, bottom, and corner edges drag to any size between 240 and 3840 pixels. `toolbar-start` and `toolbar-end` slots add your own controls to the bar, and `inset-bottom` keeps the page clear of a toolbar that floats over the bottom of the frame.

`DEVICE_FRAME_PRESETS` and `DEVICE_FRAME_BREAKPOINTS` hold the defaults. Pass `presets` or `breakpoints` to offer others, or `:breakpoints="[]"` to hide the breakpoint boxes. `disabled` shows the content full size without the bar and keeps the size for later.

## Accessibility

The bar is a `toolbar`. The device is a native select, and width, height, and zoom are number fields, each with a label. Rotate, Fit, and the breakpoint boxes are buttons; Fit and the boxes expose `aria-pressed`. The page's edges are focusable separators: arrow keys resize by 10 pixels, 50 with Shift. On touch screens the controls and edges grow to 44 pixel targets. The size eases in only when the reader allows motion.

## API Reference

### DeviceFrame

Renders a `div` with `data-slot="device-frame"`, and `data-on` while device mode shows.

#### Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `modelValue` | `DeviceFrameSize` | | The size, for `v-model`: `{ on, id, width, height, zoom }`. `zoom` is a fraction, or `null` to fit. |
| `defaultValue` | `Partial<DeviceFrameSize>` | | The first size when uncontrolled and nothing is stored. |
| `storageKey` | `string` | | Keeps the uncontrolled size in local storage. |
| `presets` | `DeviceFramePreset[]` | | The devices the bar offers. Defaults to `DEVICE_FRAME_PRESETS`. |
| `breakpoints` | `DeviceFrameBreakpoint[]` | | The one-click widths. Defaults to `DEVICE_FRAME_BREAKPOINTS`. |
| `disabled` | `boolean` | `false` | Shows the content full size without the bar. |
| `toolbar` | `boolean` | `true` | Shows the bar while device mode is on. Pass `false` when the page has its own device controls, as `WorkspacePreview` does. |
| `insetBottom` | `number` | `16` | Space in pixels under the page. |

#### Events

| Event | Payload | Description |
| --- | --- | --- |
| `update:modelValue` | `DeviceFrameSize` | The size, device, zoom, or `on` changed. |

#### Slots

| Slot | Description |
| --- | --- |
| `default` | The page. |
| `toolbar-start` | Controls before the device select. |
| `toolbar-end` | Controls before the close button. |

## Related

- [Code view](/docs/ui/code-view) shows the files the page is built from.
- [File tree](/docs/ui/file-tree) lists them.
