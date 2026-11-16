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
| `@vite-hub/kit/styles/tokens.css` | The tokens: the CSS variables of shadcn/ui with the ViteHub values, light, dark, and system dark. The values are those of `@vite-hub/ui/theme.css`. |
| `@vite-hub/kit/styles/default.css` | The `default` style family: ui-sdk's `web.css` on the tokens above, and the rules for the kit parts. Only for apps without Nuxt UI. |
| `@vite-hub/kit/styles/tailwind.css` | The Tailwind bridge: Nuxt UI's semantic utilities, such as `text-muted` and `bg-elevated`, on the tokens above. See [Tailwind](#tailwind). |
| `@vite-hub/kit/styles/default.scoped.css` | The `default` family under a `.ui-sdk` root, for apps that still render Nuxt UI. See [Next to Nuxt UI](#next-to-nuxt-ui). |

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
| Form | A native `<form>` with a `Field` for each control. To send it to `server/forms/<name>.ts` and show the server's errors by `name`, use `useFormAction()` from `@vite-hub/forms/vue`. |
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

The parts have no styles until you load a style family. A family is CSS that styles each part by its `data-slot` and its state attributes, such as `data-open` and `data-checked`. The `default` family is ui-sdk's own stylesheet, `@ui-sdk/core/web.css`, with the variables of `tokens.css` mapped onto its `--ui-*` variables and the ViteHub look: 6px controls, 12px menus and dialogs, 14px text, and a 2px focus ring. The variables use the names of shadcn/ui.

```css
/* The app's global stylesheet. */
@import "@vite-hub/kit/styles/tokens.css";
@import "@vite-hub/kit/styles/default.css";
```

`default.css` has three parts:

1. ui-sdk's `web.css`, copied into the file when the kit is built. The copy has the rules that web.css does not have yet (InputGroup, Timeline, Waterfall, SelectLabel, the NumberInput scrub area, and `<span data-slot="visually-hidden">`) and the `--ui-ring-width`, `--ui-ring-offset`, and `--ui-radius-popup` variables. They come from the workspace patch `patches/@ui-sdk__core@0.1.0-beta.5.patch`, which we send to ui-sdk.
2. An unlayered alias sheet that sets each `--ui-*` variable from its shadcn name, such as `--ui-background: var(--background)`, on `:root`, `.dark`, and `[data-theme="dark"]`, and the ViteHub look.
3. The rules for the kit's `TagsInput`, the text field focus, the dialog close button, and the looks that the ui-sdk set of `@vite-hub/ui` asks for (see below), in web.css's `ui-sdk` cascade layer.

**Load it only in apps without Nuxt UI.** web.css and Nuxt UI restyle each other: web.css has global rules on plain `a`, `kbd`, and `button`, 8 `data-slot` names are the same in both, and the alias sheet sets `--ui-border`, `--ui-primary`, and `--ui-radius`, which Nuxt UI also owns. `--ui-radius` is the whole radius in web.css but the base step in Nuxt UI. With Nuxt UI, use `@vite-hub/ui/theme.css` and Nuxt UI's components (see [Installation](https://vitehub.dev/docs/ui/installation)), or the scoped family to move to ui-sdk part by part (see [Next to Nuxt UI](#next-to-nuxt-ui)).

- **No Tailwind needed.** web.css is plain CSS in the `ui-sdk` cascade layer, so utility classes and your own CSS win over it. With Tailwind, put the `ui-sdk` layer after `base`, or Preflight resets the parts: `@layer theme, base, ui-sdk, components, utilities;` above the imports.
- **Dark mode** applies under `.dark` or `[data-theme="dark"]` on any ancestor, usually `<html>`. Before the app sets one, the page follows the system, unless `<html>` has `.light` or a `data-theme`.
- **One token set.** `tokens.css` has the values of `@vite-hub/ui/theme.css`, the tokens of the Console and the docs: a near black page in dark mode (`oklch(0.145 0 0)`), and popovers at 92% over a 12px blur. `test/tokens.test.ts` fails when the two files disagree. Change a value in both files.
- **Any shadcn theme works.** Paste its `:root` and `.dark` blocks after `tokens.css`. `--radius` is the base step: controls are 1.5 times it, cards 2 times, and menus and dialogs 3 times.
- **Focus** is a 2px ring in `--ring`, 2px outside the part. A text field turns its own frame blue instead.
- Hide text but keep it for screen readers with `<span data-slot="visually-hidden">`.
- **Variants** are attributes: `data-variant="solid"` for the main action and `data-variant="destructive"`. To change web.css itself, set its `--ui-*` variables, such as `--ui-font-size` (14px here), after the import.
- **Buttons** also take `data-variant="soft"`, `"ghost"`, and `"link"`, and `data-size="xs"` (24px) and `"sm"` (28px). An icon with `data-slot="spinner"` turns. `data-slot="dialog-footer"` lines up a dialog's actions at the end, and `menu-item-description` and `tabs-tab-badge` are small muted text. `uiSdkComponents` of `@vite-hub/ui` uses them.

## Tailwind

`@vite-hub/kit/styles/tailwind.css` keeps the semantic utilities of Nuxt UI 4.12 working without Nuxt UI. An app that removes `@import "@nuxt/ui"` keeps its classes:

```css
/* The app's global stylesheet. */
@import "tailwindcss";
@import "@vite-hub/kit/styles/tokens.css";
@import "@vite-hub/kit/styles/tailwind.css";
```

It is one `@theme inline` block that registers the names in the namespaces that Nuxt UI uses:

| Utilities | Token |
| --- | --- |
| `text-highlighted`, `text-muted`, `text-inverted` | `--foreground`, `--muted-foreground`, `--background` |
| `text-default`, `text-toned`, `text-dimmed` | `--ui-text`, `--ui-text-toned`, `--ui-text-dimmed` |
| `bg-default`, `bg-elevated`, `bg-inverted`, `bg-border` | `--background`, `--muted`, `--foreground`, `--border` |
| `bg-muted`, `bg-accented` | `--ui-bg-muted`, `--ui-bg-accented` |
| `border-*`, `ring-*`, `ring-offset-*`, `divide-*`: `default`, `muted`, `accented`, `inverted`, `bg` | `--border`, `--ui-border-muted`, `--ui-border-accented`, `--foreground`, `--background` |
| `outline-default`, `outline-inverted`, `fill-*` and `stroke-*`: `bg`, `default`, `inverted` | `--border`, `--foreground`, `--background` |
| `*-primary`, such as `bg-primary` | `--primary` |
| `*-error`, `*-warning`, `*-success`, `*-info`, such as `bg-error/10` | `--ui-error`, `--ui-warning`, `--ui-success`, `--ui-info` |
| `text-error`, `text-warning`, `text-success`, `text-info` | `--vh-text-error`, ... (the darker text shades) |
| `rounded-xs` to `rounded-3xl` | multiples of `--radius`, as in Nuxt UI |

- The steps that shadcn has no name for, and the status colors, keep their Nuxt UI (`--ui-*`) and `theme.css` (`--vh-*`) names in `tokens.css`. `@vite-hub/ui/theme.css` sets the same variables with the same values, so the bridge changes nothing in an app that still loads Nuxt UI and theme.css. The Console loads it after `@nuxt/ui` today.
- As in theme.css, only the plain `text-error` class takes the darker text shade. `text-error/80` and `hover:text-error` use the fill shade, as with Nuxt UI.
- The bridge also sets the `dark` and `light` variants on `.dark`, `.light`, and `data-theme`, and the page text and background of Nuxt UI on `body`.
- Nuxt UI 4.12 has no `decoration-default` or `border-highlighted`. Those classes draw nothing with Nuxt UI, and the bridge keeps it that way.
- `pnpm --filter @vite-hub/ui test:bridge` renders every utility of Nuxt UI and every semantic utility in the repository on two Tailwind 4 pages, one with Nuxt UI and theme.css and one with the kit tokens and the bridge, and fails when a color, border, ring, or radius differs in light or dark.

## Next to Nuxt UI

`default.scoped.css` is `default.css` with every rule under `:where(.ui-sdk)`. It styles only the elements inside an element with the `ui-sdk` class, the scope root. An app that still renders Nuxt UI loads it and moves to ui-sdk one page or one part at a time.

```css
/* The app's global stylesheet. The layer order comes first. */
@layer theme, base, ui-sdk, components, utilities;
@import "tailwindcss";
@import "@nuxt/ui";
@import "@vite-hub/kit/styles/tokens.css";
@import "@vite-hub/kit/styles/default.scoped.css";
```

```vue
<template>
  <section class="ui-sdk">
    <Tabs default-value="logs">...</Tabs>
  </section>
</template>
```

- **A scope root holds no Nuxt UI component.** Inside the root, the generic `[data-slot]` rules of web.css apply, `a`, `kbd`, `code`, and `hr` take the web.css look, and `--ui-radius` is the whole radius, where Nuxt UI reads it as a base step. Outside the root, no rule of the file applies.
- **Write the layer order line first.** `@import "tailwindcss"` names the layers `theme, base, components, utilities`. Without the line, `ui-sdk` comes after `utilities`, and web.css beats the utility classes.
- The `:where()` prefix adds no specificity, so the rules win over each other as they do in `default.css`. `@keyframes`, `@property`, and `@font-face` stay global.
- **The scope root takes the rules of `:root` and `html`**: the `--ui-*` variables and the page base (background, text color, and font). The page base is outside a layer, so a utility class such as `bg-muted` on the root itself loses to it. Put that class on a child or a wrapper.
- **Dark mode** applies under `.dark` or `[data-theme="dark"]` on `<html>`, on the scope root, or on an element inside it. The scope root takes the page's `color-scheme`.
- **Tokens** stay global: `tokens.css` sets its shadcn/ui names on `:root`. `@vite-hub/ui/theme.css` sets the same names, and the file that loads last wins for Nuxt UI and for the kit.
- **Popups** render in place, in the top layer, so a dialog, menu, or tooltip stays inside its root. A popup's `container` must be inside a scope root. Mount `OverlayHost` and a `ToastRegion` in a scope root of their own, such as `<div class="ui-sdk"><OverlayHost /></div>` near the app root. `NumberInputScrubAreaCursor` always renders in `<body>`, outside every root, so give its icon its own size.

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
