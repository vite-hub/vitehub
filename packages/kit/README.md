# @vite-hub/kit

The headless Vue parts that [ui-sdk](https://ui-sdk.dev) does not have, a Nuxt module that auto-imports them, and a plain CSS [style family](#styles) for every part.

For dialogs, menus, tabs, selects, date pickers, toasts, and every other part, use `@ui-sdk/vue` directly. Its parts have behavior, focus, keyboard, and ARIA, and no styles, and its docs ship in `node_modules/@ui-sdk/vue/docs`. The kit adds only what ui-sdk lacks, built on ui-sdk's public API with the same conventions.

## Install

```sh
pnpm add @vite-hub/kit @ui-sdk/vue @ui-sdk/core vue
```

## Import paths

Import each part from its own entry. There is no root entry.

| Import | Contents |
| --- | --- |
| `@vite-hub/kit/tags-input` | `TagsInput` and its parts. See [Components we add](#components-we-add). |
| `@vite-hub/kit/nuxt` | The Nuxt module for the parts above |
| `@vite-hub/kit/styles/tokens.css` | The tokens: the CSS variables of shadcn/ui with the ViteHub values, light and dark |
| `@vite-hub/kit/styles/default.css` | The `default` style family: plain CSS for every ui-sdk part and every kit part |

## Migrate from `@vite-hub/kit/<name>`

The kit no longer re-exports ui-sdk. `@vite-hub/kit/<name>` was `@ui-sdk/vue/<name>` with the same names, props, and types, so change the import path and install `@ui-sdk/vue` and `@ui-sdk/core`:

```diff [app.vue]
- import { Tabs, TabsList, TabsPanel, TabsTab } from "@vite-hub/kit/tabs";
+ import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/vue/tabs";
```

`@vite-hub/kit/tags-input` and the styles keep their paths. Replace `@vite-hub/kit/form` with a native `<form>` and `useFormAction()` from `@vite-hub/forms/vue`; see the [Forms Vue guide](../forms/README.md#vue). In Nuxt, add `@ui-sdk/vue/nuxt` to `modules` next to `@vite-hub/kit/nuxt`. See [Nuxt](#nuxt).

## Components we add

The kit adds a component only when it owns state, focus, ARIA, or announcements, and no ui-sdk part does the same job. It is built on ui-sdk's public API: a primitive from `definePrimitive` in `@ui-sdk/core`, and parts from `createParts` in `@ui-sdk/vue/primitive`. It follows the conventions of ui-sdk: `data-slot="<name>-<part>"`, boolean state attributes such as `data-highlighted`, `v-model` through `update:<key>`, `default<Key>` props, and a `#render` slot. Each entry also exports its primitive, such as `tagsInputPrimitive`, for your own parts.

| Import | Parts | What it does |
| --- | --- | --- |
| `@vite-hub/kit/tags-input` | `TagsInput`, `TagsInputItem`, `TagsInputItemText`, `TagsInputItemDelete`, `TagsInputInput`, `TagsInputClear` | Free text as tags. Enter or the `delimiter` adds a tag. Backspace in an empty input removes the last tag. The arrow keys move a highlight between tags, and Backspace or Delete removes the highlighted tag. With `name`, a form submits each tag. When people pick tags from suggestions, use `Combobox` with `multiple` and `ComboboxChips` instead. |

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

`TagsInput` keeps each tag once, so it has no `duplicate` prop, unlike Reka UI.

## From Reka UI

What to use in ViteHub UI for each Reka UI 2.11 component.

| Reka UI | ViteHub UI |
| --- | --- |
| Accordion | `@ui-sdk/vue/accordion` |
| AlertDialog | `@ui-sdk/vue/alert-dialog` |
| AspectRatio | Use CSS: `aspect-ratio: 16 / 9` on the element. |
| Autocomplete | `@ui-sdk/vue/autocomplete` |
| Avatar | `@ui-sdk/vue/avatar` |
| Calendar | `@ui-sdk/vue/calendar` |
| Checkbox | `@ui-sdk/vue/checkbox`, with `CheckboxGroup` for a group |
| Collapsible | `@ui-sdk/vue/collapsible` |
| ColorArea, ColorField, ColorSlider, ColorSwatch, ColorSwatchPicker | `@ui-sdk/vue/color-picker`: `ColorPickerArea`, `ColorPickerInput`, `ColorPickerSlider`, `ColorPickerSwatches` |
| Combobox | `@ui-sdk/vue/combobox` |
| ConfigProvider | Not needed. Parts read the direction from `dir`, and formatting parts follow the page language or take `locale`. |
| ContextMenu | `@ui-sdk/vue/menu`, with `MenuContextTrigger` |
| DateField | `@ui-sdk/vue/date-input` |
| DatePicker | `@ui-sdk/vue/date-picker` |
| DateRangeField, DateRangePicker | `@ui-sdk/vue/date-picker` with `mode="range"` |
| Dialog | `@ui-sdk/vue/dialog` |
| Drawer | `@ui-sdk/vue/drawer` |
| DropdownMenu | `@ui-sdk/vue/menu` |
| Editable | An `<input>` styled as text. Save on `@change`, and put the saved value back on Escape. For names in a list or a grid, `createInlineEdit` from `@ui-sdk/core`. |
| Field | `@ui-sdk/vue/field` |
| Form | A native `<form>` with `useFormAction()` from `@vite-hub/forms/vue` |
| HoverCard | `@ui-sdk/vue/hover-card` |
| Label | `@ui-sdk/vue/label` |
| Listbox | `@ui-sdk/vue/listbox` |
| Menubar | `@ui-sdk/vue/menubar` |
| MonthPicker, MonthRangePicker, YearPicker, YearRangePicker | `@ui-sdk/vue/select` with the months or years, and two of them for a range |
| NavigationMenu | `@ui-sdk/vue/navigation-menu` |
| NumberField | `@ui-sdk/vue/number-input` |
| Pagination | `@ui-sdk/vue/pagination` |
| PinInput | `@ui-sdk/vue/otp-input` |
| Popover | `@ui-sdk/vue/popover` |
| Progress | `@ui-sdk/vue/progress`, or `@ui-sdk/vue/meter` for a value in a known range |
| RadioGroup | `@ui-sdk/vue/radio` |
| RangeCalendar | `@ui-sdk/vue/calendar` with `mode="range"` |
| Rating | `@ui-sdk/vue/rating` |
| ScrollArea | `@ui-sdk/vue/scroll-area` |
| Select | `@ui-sdk/vue/select` |
| Separator | `@ui-sdk/vue/separator` |
| Slider | `@ui-sdk/vue/slider` |
| Splitter | `@ui-sdk/vue/resizable` |
| Stepper | `@ui-sdk/vue/tabs` for now. The kit may add a `stepper` entry. |
| Switch | `@ui-sdk/vue/switch` |
| Tabs | `@ui-sdk/vue/tabs` |
| TagGroup | `@ui-sdk/vue/toggle` with `ToggleGroup` and `multiple` to select tags. For tags that people remove, a list with a remove `<button>` in each tag. |
| TagsInput | `@vite-hub/kit/tags-input` |
| TimeField | `@ui-sdk/vue/time-input` |
| TimeRangeField | Two `TimeInput`s |
| Toast | `@ui-sdk/vue/toast` |
| Toggle | `@ui-sdk/vue/toggle` |
| ToggleGroup | `@ui-sdk/vue/toggle`, with `ToggleGroup` |
| Toolbar | `@ui-sdk/vue/toolbar` |
| Tooltip | `@ui-sdk/vue/tooltip` |
| Tree | `@ui-sdk/vue/tree` |
| VisuallyHidden | Use CSS: `<span data-slot="visually-hidden">`, the ui-sdk convention, with the usual clip rule. |
| Primitive (`as-child`) | The `#render` slot of each part |
| FocusScope, DismissableLayer, Presence, RovingFocus | Built into the parts that need them. For your own parts, `createRovingFocus` and the other behaviors are in `@ui-sdk/core`. |

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

## Nuxt

Add the ui-sdk module for the ui-sdk parts and helpers, and the kit module for the kit parts:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@ui-sdk/vue/nuxt", "@vite-hub/kit/nuxt"],
});
```

Then `<Dialog>`, `<TabsTab>`, `createDialogController()`, and `<TagsInput>` need no import. Install `@ui-sdk/vue` and `@ui-sdk/core` in the app itself, so that the types in `.nuxt/components.d.ts` resolve under pnpm.

To prefix the names, set the same `prefix` on both modules:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  // Registers <UiDialog> and <UiTagsInput>. Without a prefix, the names are <Dialog> and <TagsInput>.
  modules: [["@ui-sdk/vue/nuxt", { prefix: "Ui" }], ["@vite-hub/kit/nuxt", { prefix: "Ui" }]],
});
```

The `uiSdk` and `viteHubKit` keys of `nuxt.config.ts` take the same options.
