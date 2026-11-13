# @vite-hub/kit

Headless parts for Vue and Nuxt: dialogs, menus, tabs, selects, date pickers, toasts, and more. The parts have behavior, focus, keyboard, and ARIA, and no styles. You style them through their `data-slot` attributes.

The behavior comes from [ui-sdk](https://ui-sdk.dev). Each entry that has the name of an entry of `@ui-sdk/vue` re-exports it unchanged, with the same names, props, and types. The kit also adds [components that ui-sdk does not have](#components-we-add), built on ui-sdk. The package installs only `@ui-sdk/vue` and `@ui-sdk/core`, so it does not bring the editor, terminal, or highlighter dependencies of `@vite-hub/ui`.

## Install

```sh
pnpm add @vite-hub/kit vue
```

## Import paths

Import each part from its own entry, so an app loads only the parts it uses. There is no root entry.

| Import | Contents |
| --- | --- |
| `@vite-hub/kit/<name>` | The parts and helpers of `@ui-sdk/vue/<name>`, for example `@vite-hub/kit/dialog`, `@vite-hub/kit/tabs`, and `@vite-hub/kit/date-picker`. Every entry of `@ui-sdk/vue` has one. |
| `@vite-hub/kit/form`, `editable`, `tags-input`, `tag-group`, `stepper`, `aspect-ratio`, `visually-hidden` | The components that the kit adds. See [Components we add](#components-we-add). |
| `@vite-hub/kit/nuxt` | The Nuxt module |

```vue
<script setup lang="ts">
import { Tabs, TabsList, TabsPanel, TabsTab } from "@vite-hub/kit/tabs";
</script>

<template>
  <Tabs default-value="code">
    <TabsList>
      <TabsTab value="code">Code</TabsTab>
      <TabsTab value="preview">Preview</TabsTab>
    </TabsList>
    <TabsPanel value="code">...</TabsPanel>
    <TabsPanel value="preview">...</TabsPanel>
  </Tabs>
</template>
```

For the props and parts of each component, read the [ui-sdk docs](https://ui-sdk.dev).

## Components we add

ui-sdk does not have some components that Reka UI has. The kit adds them, built on ui-sdk's public API: a primitive from `definePrimitive` in `@ui-sdk/core`, and parts from `createParts` in `@ui-sdk/vue/primitive`. They follow the conventions of ui-sdk: `data-slot="<name>-<part>"`, boolean state attributes such as `data-editing`, `v-model` through `update:<key>`, `default<Key>` props, and a `#render` slot. Each entry also exports its primitive, such as `tagsInputPrimitive`, for your own parts.

| Import | Parts | What it does |
| --- | --- | --- |
| `@vite-hub/kit/form` | `Form` | A `<form>` that ties its fields to one submission. `@form-submit` gets the values by name after the browser's validation passes. `v-model:errors` shows errors from your code, such as a server's, in the `Field` of the control with the same `name`, until the person edits that control. Without an `action`, the form stays on the page. |
| `@vite-hub/kit/editable` | `Editable`, `EditableArea`, `EditablePreview`, `EditableInput`, `EditableSubmitTrigger`, `EditableCancelTrigger`, `EditableEditTrigger` | Text that turns into an input in place. Focus or a double click starts editing (`activation-mode`), and so do Enter and F2. Enter or leaving saves (`submit-mode`), and Escape cancels. Focus goes back to where editing started. |
| `@vite-hub/kit/tags-input` | `TagsInput`, `TagsInputItem`, `TagsInputItemText`, `TagsInputItemDelete`, `TagsInputInput`, `TagsInputClear` | Free text as tags. Enter or the `delimiter` adds a tag. Backspace in an empty input removes the last tag. The arrow keys move a highlight between tags, and Backspace or Delete removes the highlighted tag. With `name`, a form submits each tag. |
| `@vite-hub/kit/stepper` | `Stepper`, `StepperItem`, `StepperTrigger`, `StepperIndicator`, `StepperTitle`, `StepperDescription`, `StepperSeparator`, `StepperPrevious`, `StepperNext` | The steps of a process, such as a checkout. `v-model` binds the current step, a number. Each step shows `data-complete`, `data-current`, or `data-upcoming`. The triggers have one tab stop, on the current step, and the arrow keys move between them. With `linear`, the default, a person can only go back or one step ahead. |
| `@vite-hub/kit/aspect-ratio` | `AspectRatio` | Keeps its width and height in a `ratio`, such as `16 / 9`, with CSS `aspect-ratio`. |
| `@vite-hub/kit/visually-hidden` | `VisuallyHidden` | Content that screen readers read and people do not see. `feature="fully-hidden"` also hides it from screen readers. |
| `@vite-hub/kit/tag-group` | `TagGroup`, `TagGroupItem`, `TagGroupItemRemove` | A list of tags that a person can select and remove, as in React Aria. It is a grid with one tab stop. The arrow keys, Home, and End move focus, Space or Enter selects (`selection-mode`), and Delete or Backspace sends `@remove` for a tag that has a remove button. |

```vue
<script setup lang="ts">
import { ref } from "vue";
import { TagsInput, TagsInputInput, TagsInputItem, TagsInputItemDelete, TagsInputItemText } from "@vite-hub/kit/tags-input";

const tags = ref(["vue", "nuxt"]);
</script>

<template>
  <TagsInput v-model="tags" name="stack">
    <TagsInputItem v-for="tag in tags" :key="tag" :value="tag">
      <TagsInputItemText>{{ tag }}</TagsInputItemText>
      <TagsInputItemDelete>Remove</TagsInputItemDelete>
    </TagsInputItem>
    <TagsInputInput aria-label="Stack" />
  </TagsInput>
</template>
```

Differences from Reka UI:

- `Editable` saves on Enter and on blur by default (`submit-mode="both"`). Reka saves only on blur.
- `TagsInput` keeps each tag once. It has no `duplicate` prop.
- `TagGroup` keeps the selection in an array, also with `selection-mode="single"`.
- `StepperItem` takes the step number as `value`, not `step`. `StepperPrevious` and `StepperNext` are extra parts.
- `AspectRatio` renders one element with CSS `aspect-ratio`, not a wrapper with padding.
- There is no `Direction` part. ui-sdk reads the CSS direction of each element.

## Nuxt

The module auto-imports every part as a component, including the parts that the kit adds, and every helper, such as `createDialogController()` and `formatNumber()`. Set `prefix` when the app has its own components with the same names:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  // Registers <UiDialog>, <UiTabsTab>, and so on. Without a prefix, the names are <Dialog> and <TabsTab>.
  modules: [["@vite-hub/kit/nuxt", { prefix: "Ui" }]],
});
```

The `viteHubKit` key of `nuxt.config.ts` takes the same options.

The module installs the ui-sdk Nuxt module and points its imports at `@vite-hub/kit/<name>`. With pnpm, the app cannot resolve `@ui-sdk/vue` itself, so without this the generated types of the parts would be `any`.
