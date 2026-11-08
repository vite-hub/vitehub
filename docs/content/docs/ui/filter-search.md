---
title: Filter Search
description: "A text box that turns typed words into filter choices. It drives useChoices() and leaves the filters, the request, and the state to your app."
navigation.order: 26
navigation.group: Chat
icon: i-ph-magnifying-glass-light
---

`FilterSearch` is a text box for a filter bar. A reader types "suppliers except those starting with vak", and your filter chips change. The box shows when the request runs and when it fails. It does not draw chips, it does not send the request, and it does not hold the selection. `useChoices()` from `vite-hub/decisions/vue` does the request, and your `onSelect` applies the result to your own state.

::component-preview{name="FilterSearchExample"}
::

Type `suppliers except vak` and press Enter. Type `error` to see the error state. The `resolve` function in this example waits and answers on the page, so no request leaves it.

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports the component. In Vue with Vite, import it from `@vite-hub/ui` or from the focused entry `@vite-hub/ui/filter-search`:

```ts
import { FilterSearch } from "@vite-hub/ui";
```

## Usage

Write two bridges and one server route. The route is yours. `resolve` sends the text to it and returns the selection. `onSelect` writes the selection to your filters. Wrap `clear()` to reset those filters too.

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

Enter sends the text. Escape clears it and cancels a request that is still running. Escape and the clear button call the `clear()` on the object you pass. In this example, the wrapper clears the composable and resets your filters. `useChoices().clear()` alone resets only its own state. `FilterSearch` never calls `resolve`, so a test that passes a stub object needs no network.

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

- One prop connects it: `choices` takes the object that `useChoices()` returns. The type is structural, so any object with `text`, `status`, `error`, `submit`, `clear`, and `abort` works.
- A loading icon while the status is `thinking`, and a clear button when the text is not empty.
- The error shows as text under the input. The `#error` slot replaces it.
- `#leading` and `#trailing` slots for an icon or a filter menu.
- Every part has a `data-slot` and a `data-state` (`idle`, `thinking`, `ready`, or `error`), so one CSS selector styles a part for each state.
- No chips. Your filter bar shows the selection, so it matches the rest of your page.

## Headless parts

Use the parts without Nuxt UI when you need your own markup, for example in a command palette. Import them from `@vite-hub/ui/choices-input`, or from `@vite-hub/ui/headless`. They have no styles, and the Nuxt module does not auto-import them:

```vue
<script setup lang="ts">
import { ChoicesInput, ChoicesInputClear, ChoicesInputError, ChoicesInputField, ChoicesInputStatus } from "@vite-hub/ui/choices-input";
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

`ChoicesInputField` renders an `input`. Set `as` to render a component instead. The component receives `modelValue` and `onUpdate:modelValue`, and the other attributes. `FilterSearch` does this with `UInput`.

## Accessibility

The input has an accessible name from `label`. While the status is `thinking`, it has `aria-busy="true"`. After a failed request it has `aria-invalid="true"` and `aria-describedby` points to the error text.

`ChoicesInputStatus` is a polite live region (`role="status"`). It stays in the page from the first render, and it says "Thinking", then "Ready", or the error message. `FilterSearch` hides it from sight with `vh-visually-hidden`, because the loading icon and the error text already show the state.

Enter sends the text. Editing cancels a running request, so its result cannot apply after the text changes. Escape clears it, and cancels a request that is running. When there is nothing to clear, Escape goes to the page, so it can still close a dialog. Enter does nothing while an input method composes text, and it does nothing with Shift, Ctrl, Alt, or Meta held.

## API Reference

### FilterSearch

The styled component. Renders a `div` with `data-slot="choices-input"`, the Nuxt UI input, the hidden live region, and the error.

#### Props

| Prop          | Type                                      | Default    | Description                                                    |
| ------------- | ----------------------------------------- | ---------- | -------------------------------------------------------------- |
| `choices`     | `ChoicesInputSource`                      | Required   | The object that `useChoices()` returns.                        |
| `label`       | `string`                                  | `"Search"` | The accessible name of the input.                              |
| `placeholder` | `string`                                  |            | The placeholder of the input.                                  |
| `size`        | `"xs" \| "sm" \| "md" \| "lg" \| "xl"`    | `"md"`     | The size of the Nuxt UI input.                                 |

#### Slots

| Slot       | Props       | Description                                                          |
| ---------- | ----------- | -------------------------------------------------------------------- |
| `#leading` |             | Content at the start of the input.                                   |
| `#trailing`|             | Content at the end of the input, after the loading icon or clear button. |
| `#error`   | `{ error }` | Replaces the error message. It shows only after a failed request.    |

### ChoicesInputSource

The type of the `choices` prop. `useChoices()` returns an object of this shape:

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

The root of the headless parts. Renders a `div` with `data-slot="choices-input"` and `data-state`. The default slot receives `{ state }`.

#### Props

| Prop      | Type                 | Default  | Description                             |
| --------- | -------------------- | -------- | --------------------------------------- |
| `choices` | `ChoicesInputSource` | Required | The object that `useChoices()` returns. |

### ChoicesInputField

The text box. Renders an `input` with `data-slot="choices-input-field"`. Enter sends the text and Escape clears it.

#### Props

| Prop    | Type                 | Default    | Description                                                                                       |
| ------- | -------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `as`    | `string \| Component` | `"input"`  | The element or component to render. A component receives `modelValue` and `onUpdate:modelValue`. |
| `label` | `string`             | `"Search"` | The accessible name of the input.                                                                 |

### ChoicesInputClear

A button that cancels a running request and clears the text. Renders a `button` with `data-slot="choices-input-clear"`.

#### Props

| Prop    | Type                 | Default    | Description                                                   |
| ------- | -------------------- | ---------- | ------------------------------------------------------------- |
| `as`    | `string \| Component` | `"button"` | The element or component to render, for example your own button. |
| `label` | `string`             | `"Clear"`  | The accessible name of the button.                            |

### ChoicesInputStatus

A polite live region. Renders a `div` with `data-slot="choices-input-status"` and `role="status"`. It says "Thinking", "Ready", or the error message. The default slot receives `{ message, state }` and replaces the text. Has no props.

### ChoicesInputError

The error as text. Renders a `p` with `data-slot="choices-input-error"` only while the status is `error`. The default slot receives `{ error }` and replaces the message. Has no props.

## Related

- [Prompt Input](/docs/ui/prompt-input) collects a chat message instead of a filter.
