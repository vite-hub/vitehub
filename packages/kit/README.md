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
| `@vite-hub/kit/tags-input` | A component that the kit adds. See [Components we add](#components-we-add). |
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

The kit adds a component only when it owns state, focus, ARIA, or announcements, and no ui-sdk part does the same job. It is built on ui-sdk's public API: a primitive from `definePrimitive` in `@ui-sdk/core`, and parts from `createParts` in `@ui-sdk/vue/primitive`. It follows the conventions of ui-sdk: `data-slot="<name>-<part>"`, boolean state attributes such as `data-highlighted`, `v-model` through `update:<key>`, `default<Key>` props, and a `#render` slot. The entry also exports its primitive, `tagsInputPrimitive`, for your own parts.

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

What to use in ViteHub UI for each Reka UI 2.11 component. An entry such as `dialog` means `@vite-hub/kit/dialog`.

| Reka UI | ViteHub UI |
| --- | --- |
| Accordion | `accordion` |
| AlertDialog | `alert-dialog` |
| AspectRatio | Use CSS: `aspect-ratio: 16 / 9` on the element. |
| Autocomplete | `autocomplete` |
| Avatar | `avatar` |
| Calendar | `calendar` |
| Checkbox | `checkbox`, with `CheckboxGroup` for a group |
| Collapsible | `collapsible` |
| ColorArea, ColorField, ColorSlider, ColorSwatch, ColorSwatchPicker | `color-picker`: `ColorPickerArea`, `ColorPickerInput`, `ColorPickerSlider`, `ColorPickerSwatches` |
| Combobox | `combobox` |
| ConfigProvider | Not needed. Parts read the direction from `dir`, and formatting parts follow the page language or take `locale`. |
| ContextMenu | `menu`, with `MenuContextTrigger` |
| DateField | `date-input` |
| DatePicker | `date-picker` |
| DateRangeField, DateRangePicker | `date-picker` with `mode="range"` |
| Dialog | `dialog` |
| Drawer | `drawer` |
| DropdownMenu | `menu` |
| Editable | An `<input>` styled as text. Save on `@change`, and put the saved value back on Escape. For names in a list or a grid, `createInlineEdit` from `@ui-sdk/core`. |
| Field | `field` |
| Form | A native `<form>` with `field`. For an error from the server, pass `invalid` to the `Field` and show the message in a `FieldError` with `match`. |
| HoverCard | `hover-card` |
| Label | `label` |
| Listbox | `listbox` |
| Menubar | `menubar` |
| MonthPicker, MonthRangePicker, YearPicker, YearRangePicker | `select` with the months or years, and two of them for a range |
| NavigationMenu | `navigation-menu` |
| NumberField | `number-input` |
| Pagination | `pagination` |
| PinInput | `otp-input` |
| Popover | `popover` |
| Progress | `progress`, or `meter` for a value in a known range |
| RadioGroup | `radio` |
| RangeCalendar | `calendar` with `mode="range"` |
| Rating | `rating` |
| ScrollArea | `scroll-area` |
| Select | `select` |
| Separator | `separator` |
| Slider | `slider` |
| Splitter | `resizable` |
| Stepper | `stepper` |
| Switch | `switch` |
| Tabs | `tabs` |
| TagGroup | `toggle` with `ToggleGroup` and `multiple` to select tags. For tags that people remove, a list with a remove `<button>` in each tag. |
| TagsInput | `tags-input` |
| TimeField | `time-input` |
| TimeRangeField | Two `TimeInput`s |
| Toast | `toast` |
| Toggle | `toggle` |
| ToggleGroup | `toggle`, with `ToggleGroup` |
| Toolbar | `toolbar` |
| Tooltip | `tooltip` |
| Tree | `tree` |
| VisuallyHidden | Use CSS: `<span data-slot="visually-hidden">`, the ui-sdk convention, with the usual clip rule. |
| Primitive (`as-child`) | The `#render` slot of each part |
| FocusScope, DismissableLayer, Presence, RovingFocus | Built into the parts that need them. For your own parts, `createRovingFocus` and the other behaviors are in `@ui-sdk/core`. |

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
