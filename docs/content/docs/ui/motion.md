---
title: Motion
description: "Morph a label, roll a count, swap an icon, move a list, show progress, take dropped files, and delete with Undo, with the motion helpers of @vite-hub/ui."
navigation.order: 18
navigation.group: Parts
icon: i-lucide-sparkles
---

Most motion in `@vite-hub/ui` needs no code. The motion layer moves a control by its role: a press squashes a button, a switch knob travels, a tab indicator slides, a tooltip rises. The parts on this page are for changes that only your component knows about: a label, a count, or an icon that changes with state, a list that changes, work that runs, files that a person drags in, and a delete that can be undone. The rules behind them are in [docs/design/motion.md](https://github.com/vite-hub/vitehub/blob/main/docs/design/motion.md).

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the parts. In Vue with Vite, import them from `vite-hub/ui`:

```ts
import { DropField, HoldToDelete, MorphText, MotionList, Progress, RollNumber, SwapIcon } from "vite-hub/ui";
```

## Usage

The label of a `UButton` already morphs when it changes. Use `MorphText` for a label outside a button:

```vue
<template>
  <MorphText :text="copied ? 'Copied' : 'Copy link'" />
</template>
```

Use `RollNumber` for a count. Only the digits that change roll, up when the count grows and down when it shrinks:

```vue
<template>
  <RollNumber :value="comments.length" />
  <RollNumber :value="cents" :text="formatPrice(cents)" />
</template>
```

Use `SwapIcon` for an icon that says what happened. Set `exit` and `enter` with the new name: an arrow can leave the way it points, and a check or a spinner draws its stroke:

```vue
<template>
  <SwapIcon :name="saved ? 'i-lucide-check' : 'i-lucide-save'" :enter="saved ? 'draw' : undefined" />
</template>
```

Use `MotionList` in place of `<TransitionGroup>`. Render keyed items in its slot: neighbors spring to their new place, a new item grows from `origin` (the row it duplicates) or from its slot, and a removed item folds away:

```vue
<template>
  <MotionList tag="ul">
    <li v-for="file in files" :key="file.id">{{ file.name }}</li>
  </MotionList>
</template>
```

Use `Progress` for work that runs, `DropField` for files that a person drags in, and `HoldToDelete` for a delete that can wait for Undo:

```vue
<template>
  <Progress :value="upload.progress" :done="upload.done" label="Upload cover.png" />
  <DropField accept="image/*" multiple @files="upload" />
  <HoldToDelete :commit="() => removeFile(file.id)" @delete="hidden = true" @undo="hidden = false" />
</template>
```

`v-ring="done"` rings an element once each time `done` becomes true, for a finished action such as saved or copied. `createViteHubUI()` registers it.

Some motion comes from attributes, with no part:

- `data-motion-appear="<trigger>"` on an element that appears next to its trigger, such as a bubble next to a pin, makes it come out of the trigger as a tooltip does. The value selects the trigger around the element or next to it.
- `data-motion-turn="180"` on a chevron in a control with `aria-expanded`, or in a `<details>`, turns it with a spring when the control opens. Set the same `rotate` in CSS for the open state.
- `data-leaving="true"` on a mark that the page removes a moment later folds a copy of it away.

## Animation

Each part continues from where it is when its value changes again in the middle of its motion. The element keeps the final text for screen readers the whole time, and holds plain text again at the end. With reduced motion turned on in the system, the parts crossfade in 150ms. Inside `data-motion="none"` they change at once.

## Without Vue

`morphText(element, text)`, `rollNumber(element, value, format?)`, `swapIcon(container, icon, { exit, enter })`, `ring(element)`, `shake(element)` for a box that refuses an action, `createMotionList(container)`, `createProgress(host)`, `createDropField(field, options)`, and `createHoldToDelete(button, options)` from `@vite-hub/ui/motion` do the same on any element.

## API Reference

### MorphText

Renders `as` with `data-slot="morph-text"`.

#### Props

| Prop   | Type     | Default  | Description                                  |
| ------ | -------- | -------- | -------------------------------------------- |
| `text` | `string` | Required | The text. A new text morphs letter by letter. |
| `as`   | `string` | `"span"` | The element to render.                       |

### RollNumber

Renders `as` with `data-slot="roll-number"` and tabular numbers.

#### Props

| Prop     | Type                        | Default  | Description                                                        |
| -------- | --------------------------- | -------- | ------------------------------------------------------------------ |
| `value`  | `number`                    | Required | The number. The direction of the roll follows it.                  |
| `format` | `(value: number) => string` |          | Turns the number into its text, such as `n => n.toLocaleString()`. |
| `text`   | `string`                    |          | The text of `value` when the app formats it already. It wins over `format`. |
| `as`     | `string`                    | `"span"` | The element to render.                                             |

### SwapIcon

Renders a `span` with `data-slot="swap-icon"` that holds a `UIcon`, or the default slot, for each icon. `class` goes to each icon.

#### Props

| Prop    | Type                                                        | Default  | Description                                       |
| ------- | ----------------------------------------------------------- | -------- | ------------------------------------------------- |
| `name`  | `string`                                                    | Required | The icon. A new name swaps the icon.              |
| `exit`  | `"blur" \| "left" \| "right" \| "up" \| "down"`             | `"blur"` | How the old icon leaves.                          |
| `enter` | `"blur" \| "draw" \| "left" \| "right" \| "up" \| "down"`   |          | How the new icon comes in. A spinner draws by default, other icons blur in. |
| `spin`  | `boolean`                                                   | `false`  | The icon turns, as a spinner does.                |

### MotionList

Renders `tag` with the items of its default slot.

#### Props

| Prop     | Type                                                  | Default | Description                                                     |
| -------- | ----------------------------------------------------- | ------- | --------------------------------------------------------------- |
| `tag`    | `string`                                              | `"div"` | The element of the list, such as `ul` or `ol`.                  |
| `origin` | `(item: HTMLElement) => Element \| null \| undefined` |         | Where a new item comes from, such as the row that it duplicates. |
| `target` | `() => Element \| null \| undefined`                  |         | Where a removed item goes, such as the trash.                   |

### Progress

Renders a `div` with `role="progressbar"`, `aria-valuenow`, and `data-slot="progress"`.

#### Props

| Prop    | Type             | Default | Description                                                                 |
| ------- | ---------------- | ------- | --------------------------------------------------------------------------- |
| `value` | `number \| null` |         | A fraction from 0 to 1, or `null` while work runs with no known total. Without a value the bar is empty. |
| `done`  | `boolean`        | `false` | The work is done. A dot draws into a check.                                 |
| `label` | `string`         |         | The accessible name, such as "Upload cover.png".                            |

### DropField

Renders a `label` with `data-slot="drop-field"` around a native file input. The default slot gets `{ over }`, true while a file is over the field.

#### Props

| Prop          | Type      | Default                  | Description                                          |
| ------------- | --------- | ------------------------ | ---------------------------------------------------- |
| `accept`      | `string`  |                          | The file types of the file picker.                   |
| `multiple`    | `boolean` | `false`                  | Take more than one file.                             |
| `disabled`    | `boolean` | `false`                  | Take no files.                                       |
| `label`       | `string`  | `"Drop files to upload"` | The text of the field.                               |
| `description` | `string`  | `"or click to browse"`   | The second line, such as the size limit.             |

#### Events

| Event   | Payload  | Description                          |
| ------- | -------- | ------------------------------------ |
| `files` | `File[]` | Files were dropped or picked.        |

### HoldToDelete

Renders a `button` with `data-slot="hold-to-delete"`. Hold it to delete. A click, such as from a screen reader, asks `confirm` first.

#### Props

| Prop        | Type                                   | Default           | Description                                                         |
| ----------- | -------------------------------------- | ----------------- | ------------------------------------------------------------------- |
| `commit`    | `() => void \| Promise<void>`          | Required          | The real delete. It runs once, after the Undo window.               |
| `item`      | `() => Element \| null \| undefined`   |                   | The item that leaves toward the trash, such as the row of the button. |
| `label`     | `string`                               | `"Hold to delete"` | An empty label shows only the trash can. Then give the button an `aria-label`. |
| `undoLabel` | `string`                               | `"Undo"`          | The label of the Undo button.                                       |
| `undoFor`   | `number`                               | `5000`            | How long Undo stays, in ms.                                         |
| `confirm`   | `() => boolean \| Promise<boolean>`    |                   | Asked before a delete that comes from a click and not a hold.       |

#### Events

| Event    | Payload             | Description                                           |
| -------- | ------------------- | ----------------------------------------------------- |
| `delete` | None                | The hold finished. Hide the item.                     |
| `undo`   | None                | Undo was pressed, or `commit` failed. Show the item again. |
| `error`  | `unknown`           | `commit` failed.                                      |
| `state`  | `HoldToDeleteState` | The state of the button changed.                      |

## Related

- [Copy Button](/docs/ui/copy-button) uses `SwapIcon`, `MorphText`, and `ring`.
