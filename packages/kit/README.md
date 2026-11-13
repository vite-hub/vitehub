# @vite-hub/kit

Headless parts for Vue and Nuxt: dialogs, menus, tabs, selects, date pickers, toasts, and more. The parts have behavior, focus, keyboard, and ARIA, and no styles. You style them through their `data-slot` attributes, or load a [style family](#styles).

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
| `@vite-hub/kit/form`, `editable`, `tags-input`, `tag-group` | The components that the kit adds. See [Components we add](#components-we-add). |
| `@vite-hub/kit/nuxt` | The Nuxt module |
| `@vite-hub/kit/styles/tokens.css` | The tokens: the CSS variables of shadcn/ui with the ViteHub values, light and dark |
| `@vite-hub/kit/styles/default.css` | The `default` style family: plain CSS for every part |

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
## Styles

The parts have no styles until you load a style family. A family is one CSS file that styles each part by its `data-slot` and its state attributes, such as `data-open` and `data-checked`. It reads only the variables of `tokens.css`, which use the names of shadcn/ui.

```css
/* The app's global stylesheet. ui-sdk's own layer comes first, so the family wins over it. */
@layer ui-sdk;
@import "@vite-hub/kit/styles/tokens.css";
@import "@vite-hub/kit/styles/default.css";
```

- **No Tailwind needed.** The family is plain CSS in the `components` cascade layer, so utility classes and your own CSS win over it. With Tailwind, keep these lines above `@import "tailwindcss"`.
- **Dark mode** applies under `.dark` or `[data-theme="dark"]` on any ancestor, usually `<html>`.
- **Any shadcn theme works.** Paste its `:root` and `.dark` blocks after `tokens.css`. `--radius` is the base step: controls are 1.5 times it, cards 2 times, and menus and dialogs 3 times.
- Hide text but keep it for screen readers with `<span data-slot="visually-hidden">`.
- **Variants** are attributes: `data-variant="solid"` for the main action, `data-variant="ghost"` for toolbar and row actions, and `data-variant="destructive"`.
- **Motion:** dialogs, toasts, and panels fade in through `data-starting-style` and `data-ending-style`. Menus, selects, popovers, and tooltips appear at once. Under `prefers-reduced-motion`, only the fades stay.

## Registry

`registry/` holds the `@vitehub` registry in the shadcn-vue format. `pnpm --filter @vite-hub/kit build:registry` writes it to `docs/public/r/`, which vitehub.dev serves at `/r/<name>.json`. A test fails when the files there are out of date, when an item does not match the vendored shadcn-vue 2.9.0 schema, or when an item depends on a registry item outside `@vitehub`, since stock shadcn-vue items install Reka UI.

| Item | Type | What `shadcn-vue add` writes |
| --- | --- | --- |
| `vitehub` | `registry:style` | The tokens into the app's CSS, and the family to `styles/vitehub.css` |
| `vitehub-ui-skill` | `registry:item` | `.agents/skills/vitehub-ui/SKILL.md` |

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
