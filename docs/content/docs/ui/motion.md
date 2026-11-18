---
title: Motion
description: "Morph a label, roll a count, and swap an icon with the motion helpers of @vite-hub/ui, in Vue or without it."
navigation.order: 18
navigation.group: Parts
icon: i-lucide-sparkles
---

Most motion in `@vite-hub/ui` needs no code. The motion layer moves a control by its role: a press squashes a button, a switch knob travels, a tab indicator slides, a tooltip rises. The parts on this page are for changes that only your component knows about: a label, a count, or an icon that changes with state. The rules behind them are in [docs/design/motion.md](https://github.com/vite-hub/vitehub/blob/main/docs/design/motion.md).

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the parts. In Vue with Vite, import them from `vite-hub/ui`:

```ts
import { MorphText, RollNumber, SwapIcon } from "vite-hub/ui";
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

`v-ring="done"` rings an element once each time `done` becomes true, for a finished action such as saved or copied. `createViteHubUI()` registers it.

## Animation

Each part continues from where it is when its value changes again in the middle of its motion. The element keeps the final text for screen readers the whole time, and holds plain text again at the end. With reduced motion turned on in the system, the parts crossfade in 150ms. Inside `data-motion="none"` they change at once.

## Without Vue

`morphText(element, text)`, `rollNumber(element, value, format?)`, `swapIcon(container, icon, { exit, enter })`, and `ring(element)` from `@vite-hub/ui/motion` do the same on any element.

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

## Related

- [Copy Button](/docs/ui/copy-button) uses `SwapIcon`, `MorphText`, and `ring`.
