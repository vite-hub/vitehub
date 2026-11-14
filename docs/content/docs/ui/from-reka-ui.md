---
title: Migrate from Reka UI
description: "Move a Vue app from Reka UI to ui-sdk parts: the part for each Reka UI component, the new state attributes, and what becomes CSS."
navigation.title: From Reka UI
navigation.order: 4
navigation.group: Start
icon: i-lucide-arrow-right-left
---

ui-sdk parts do the same jobs as Reka UI parts, with the same keyboard and ARIA. Most moves change three things: the import path, the root name, and the state attributes in your styles.

```diff [app/components/ShareDialog.vue]
 <script setup lang="ts">
-import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, DialogTrigger } from "reka-ui"
+import { Dialog, DialogBackdrop, DialogContent, DialogTitle, DialogTrigger } from "@ui-sdk/vue/dialog"
 </script>

 <template>
-  <DialogRoot>
+  <Dialog>
     <DialogTrigger>Share</DialogTrigger>
-    <DialogPortal>
-      <DialogOverlay class="fixed inset-0 bg-black/40" />
-      <DialogContent class="data-[state=open]:animate-in">
-        <DialogTitle>Share link</DialogTitle>
-      </DialogContent>
-    </DialogPortal>
-  </DialogRoot>
+    <DialogBackdrop class="fixed inset-0 bg-black/40" />
+    <DialogContent class="transition-opacity data-starting-style:opacity-0">
+      <DialogTitle>Share link</DialogTitle>
+    </DialogContent>
+  </Dialog>
 </template>
```

- **Imports:** each part has its own entry, `@ui-sdk/vue/<name>`. In Nuxt, the `@ui-sdk/vue/nuxt` module imports them for you.
- **Roots:** `DialogRoot` becomes `Dialog`, `TabsRoot` becomes `Tabs`, and so on. `v-model:open` and the other `v-model` names stay.
- **Portals:** remove `DialogPortal` and the other portals. Popups open in the browser's top layer, where they are.
- **`as-child`:** use the `#render` slot of the part.

## State attributes

Reka UI puts state in one `data-state` value. ui-sdk gives each state its own attribute:

| Reka UI | ui-sdk |
| --- | --- |
| `data-state="open"`, `"closed"` | `data-open`, `data-closed` |
| `data-state="checked"`, `"unchecked"`, `"indeterminate"` | `data-checked`, `data-unchecked`, `data-indeterminate` |
| `data-state="active"` on a tab | `data-selected` |
| `data-state="on"` on a toggle | `data-pressed` |
| `data-highlighted`, `data-disabled` | The same |

Selectors and Tailwind CSS variants get shorter: `[data-state="open"]` becomes `[data-open]`, and `data-[state=open]:` becomes `data-open:`.

For enter and exit motion, use `data-starting-style` and `data-ending-style`. A part stays on the page until its exit transition ends.

## AspectRatio and VisuallyHidden

Neither part has behavior, so they become CSS:

- **AspectRatio:** set `aspect-ratio: 16 / 9` on the element.
- **VisuallyHidden:** use `<span data-slot="visually-hidden">`. `@vite-hub/kit/styles/default.css` and `@vite-hub/ui/styles.css` hide it and keep it for screen readers. Without them, add the usual clip rule to your CSS.

## Every Reka UI part

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
| Form | A native `<form>` with a `Field` for each control. To send it to `server/forms/<name>.ts` and show the server's errors by `name`, use [`useFormAction()`](/docs/forms/vue) from `@vite-hub/forms/vue`. |
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
