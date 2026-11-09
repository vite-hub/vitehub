---
title: Filter Search
description: "A text box that turns typed words into filter choices. It drives useChoices() and leaves the filters, the request, and the state to your app."
navigation.order: 26
navigation.group: Chat
icon: i-lucide-search
---

`FilterSearch` is a text box for a filter bar. A reader types "suppliers except those starting with vak", and your filter chips change. The box shows when the request runs and when it fails. It does not draw chips, send the request, or hold the selection. `useChoices()` from `vite-hub/decisions/vue` sends the request, and your `onSelect` applies the result to your state.

::example{name="FilterSearchExample" height=8}
::

Type `suppliers except vak` and press Enter. Type `error` to see the error state. The example's `resolve` answers on the page, so no request leaves it.

## Installation

Install `@vite-hub/ui` as [Installation](/docs/ui/installation) shows. `vite-hub/nuxt` auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui`:

```ts
import { FilterSearch } from "@vite-hub/ui";
```

## Usage

Write one server route and two functions:

- `resolve` sends the text to your route and returns the selection.
- `onSelect` writes the selection to your filters.

Wrap `clear()` to reset your filters too.

```vue
<script setup lang="ts">
import type { forecast } from "~~/server/choices/forecast";
import { useChoices } from "vite-hub/decisions/vue";

const filters = useFilters();

const input = useChoices<typeof forecast>({
  onSelect: (selection) => filters.apply(selection),
  resolve: (text, { signal }) => $fetch("/api/choices/forecast", { body: { text }, method: "POST", signal }),
});

const choices = {
  ...input,
  clear: () => {
    input.clear();
    filters.reset();
  },
};
</script>

<template>
  <FilterSearch :choices="choices" label="Filter demand" placeholder="Try: suppliers except those starting with vak" />
</template>
```

Enter sends the text. Escape clears it and cancels a running request. Escape and the clear button call `clear()` on the object you pass. Here, the wrapper clears the composable and resets your filters. `useChoices().clear()` alone resets only its own state. `FilterSearch` never calls `resolve`, so a test with a stub object needs no network.

## Composition

```text
FilterSearch
└── ChoicesInput
    ├── ChoicesInputField (a Nuxt UI UInput)
    │   ├── #leading
    │   └── #trailing: loading icon or ChoicesInputClear, then your #trailing
    ├── ChoicesInputStatus (hidden live region)
    └── ChoicesInputError (#error)
```

## Features

- One prop, `choices`, takes the object from `useChoices()`. Any object with `text`, `status`, `error`, `submit`, `clear`, and `abort` works.
- A loading icon while `thinking`, and a clear button when there is text.
- The error shows as text under the input. The `#error` slot replaces it.
- `#leading` and `#trailing` slots for an icon or a filter menu.
- Every part has a `data-slot` and a `data-state` (`idle`, `thinking`, `ready`, or `error`) for CSS.
- No chips. Your filter bar shows the selection, so it matches your page.

## Headless parts

Use the parts without Nuxt UI for your own markup, such as a command palette. Import them from `@vite-hub/ui/headless`. They have no styles, and `vite-hub/nuxt` does not auto-import them:

```vue
<script setup lang="ts">
import { ChoicesInput, ChoicesInputClear, ChoicesInputError, ChoicesInputField, ChoicesInputStatus } from "@vite-hub/ui/headless";
</script>

<template>
  <ChoicesInput :choices="choices">
    <ChoicesInputField label="Filter demand" class="my-input" />
    <ChoicesInputClear class="my-clear">Clear</ChoicesInputClear>
    <ChoicesInputStatus class="sr-only" />
    <ChoicesInputError class="my-error" />
  </ChoicesInput>
</template>
```

`ChoicesInputField` renders an `input`. Set `as` to render a component that receives `modelValue`, `onUpdate:modelValue`, and the other attributes. `FilterSearch` does this with `UInput`.

## Accessibility

- The input gets its accessible name from `label`. While `thinking`, it has `aria-busy="true"`. After a failed request, it has `aria-invalid="true"`, and `aria-describedby` points to the error.

- `ChoicesInputStatus` is a polite live region (`role="status"`) from the first render. It says "Thinking", then "Ready" or the error. `FilterSearch` hides it visually with `vh-visually-hidden`, because the icon and error text already show the state.

- Editing cancels a running request, so a stale result cannot apply. With nothing to clear, Escape goes to the page, so it can still close a dialog. Enter does nothing during input method composition or with Shift, Ctrl, Alt, or Meta held.

## API Reference

### FilterSearch

The styled component. Renders a `div` with `data-slot="choices-input"`, the Nuxt UI input, the hidden live region, and the error.

#### Props

| Prop          | Type                                      | Default    | Description                                                    |
| ------------- | ----------------------------------------- | ---------- | -------------------------------------------------------------- |
| `choices`     | `ChoicesInputSource`                      | Required   | The object from `useChoices()`. |
| `label`       | `string`                                  | `"Search"` | The input's accessible name. |
| `placeholder` | `string`                                  |            | The input placeholder. |
| `size`        | `"xs" \| "sm" \| "md" \| "lg" \| "xl"`    | `"md"`     | The Nuxt UI input size. |

#### Slots

| Slot       | Props       | Description                                                          |
| ---------- | ----------- | -------------------------------------------------------------------- |
| `#leading` |             | Content at the start of the input. |
| `#trailing`|             | Content at the end, after the loading icon or clear button. |
| `#error`   | `{ error }` | Replaces the error message, shown only after a failed request. |

### ChoicesInputSource

The type of the `choices` prop, which `useChoices()` returns:

```ts
import type { Ref } from "vue"

interface ChoicesInputSource {
  abort: () => void;
  clear: () => void;
  error: Readonly<Ref<Error | undefined>>;
  status: Readonly<Ref<"idle" | "thinking" | "ready" | "error">>;
  submit: () => Promise<void> | void;
  text: Ref<string>;
}
```

### ChoicesInput

The headless root. Renders a `div` with `data-slot="choices-input"` and `data-state`. The default slot receives `{ state }`.

#### Props

| Prop      | Type                 | Default  | Description                             |
| --------- | -------------------- | -------- | --------------------------------------- |
| `choices` | `ChoicesInputSource` | Required | The object from `useChoices()`. |

### ChoicesInputField

The text box. Renders an `input` with `data-slot="choices-input-field"`. Enter sends the text and Escape clears it.

#### Props

| Prop    | Type                 | Default    | Description                                                                                       |
| ------- | -------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `as`    | `string \| Component` | `"input"`  | Element or component to render. A component receives `modelValue` and `onUpdate:modelValue`. |
| `label` | `string`             | `"Search"` | The input's accessible name. |

### ChoicesInputClear

Cancels a running request and clears the text. Renders a `button` with `data-slot="choices-input-clear"`.

#### Props

| Prop    | Type                 | Default    | Description                                                   |
| ------- | -------------------- | ---------- | ------------------------------------------------------------- |
| `as`    | `string \| Component` | `"button"` | Element or component to render, such as your own button. |
| `label` | `string`             | `"Clear"`  | The button's accessible name. |

### ChoicesInputStatus

A polite live region. Renders a `div` with `data-slot="choices-input-status"` and `role="status"`. It says "Thinking", "Ready", or the error. The default slot receives `{ message, state }` and replaces the text. No props.

### ChoicesInputError

Renders the error in a `p` with `data-slot="choices-input-error"`, only while the status is `error`. The default slot receives `{ error }` and replaces the message. No props.

## Related

- [Prompt Input](/docs/ui/prompt-input) collects a chat message instead of a filter.
