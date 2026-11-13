---
title: Copy Button
description: "Copy a command, an ID, or a link with one button that confirms in place and announces the result."
navigation.order: 16
navigation.group: Parts
icon: i-lucide-copy
---

`CopyButton` copies text to the clipboard. After a copy it shows a check for 2 seconds and tells screen readers "Copied". It is a Nuxt UI `UButton` with the theme defaults: neutral, ghost, and icon-only unless you give it a label.

::example{name="CopyButtonExample" height=8}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports `CopyButton`. In Vue with Vite, import it from `@vite-hub/ui`:

```ts
import { CopyButton, useCopy } from "@vite-hub/ui";
```

## Usage

Pass the text as `value`. Name an icon-only button with `aria-label`, so a screen reader says what it copies:

```vue
<template>
  <CopyButton value="pnpm add vite-hub" aria-label="Copy the install command" />
  <CopyButton :value="runId" label="Copy run ID" size="xs" />
</template>
```

Pass `icon` when the copied text has its own icon, such as a link. The check still shows after a copy:

```vue
<template>
  <CopyButton :value="pageUrl" icon="i-lucide-link" label="Copy link" variant="outline" />
</template>
```

`value` can also be a function. Use one when the text is expensive or must load first, such as the Markdown of a page. The button shows the loading icon until the text is ready:

```vue
<template>
  <CopyButton :value="() => $fetch('/raw/page.md', { responseType: 'text' })" label="Copy page" variant="outline" />
</template>
```

## Copy from a menu

A menu item that copies is not a button. Use `useCopy()`, the same clipboard logic, and confirm with a toast:

```ts
import { useToast } from "@nuxt/ui/composables";
import { useCopy } from "@vite-hub/ui";

const toast = useToast();
const { copy } = useCopy();

const items = [{
  label: "Copy link",
  icon: "i-lucide-link",
  onSelect: async () => {
    if (await copy(location.href)) toast.add({ title: "Link copied" });
  },
}];
```

`copy(value)` resolves to `true` when the text is on the clipboard, and `false` when the browser refused. It never rejects. `copied` and `failed` stay `true` for 2 seconds, or for the `duration` that you pass in ms.

## Features

- The icon swaps from `copy`, or the `icon` prop, to `copyCheck` of Nuxt UI's `appConfig.ui.icons`, so the button follows the theme. The label stays the same, so the button does not change size.
- The button announces "Copied" or "Copy failed" through a polite live region. Inside a dialog, the region is in the dialog, so the screen reader still reads it.
- Outside a secure context, such as a dev server on a LAN address, the clipboard API is missing or refuses. The button then copies with the older `document.execCommand("copy")`.
- A clipboard that the browser blocks does not throw. The button keeps the copy icon, announces "Copy failed", and emits `error`.
- A function `value` that returns a promise copies through a `ClipboardItem` where the browser has one, so Safari accepts the write after the click.

## Accessibility

The button is named "Copy" when it has no label and no `aria-label`. Give an icon-only button an `aria-label` that names the thing, such as "Copy run ID", when more than one copy button is on the page. The name does not change after a copy. The result is announced instead, so focus stays where it is.

## API Reference

### CopyButton

Renders a Nuxt UI `UButton` with `data-slot="copy-button"`, and `data-copied` for 2 seconds after a copy. Other attributes, such as `class` and `color`, pass to the button.

#### Props

| Prop        | Type                                                   | Default   | Description                                                              |
| ----------- | ------------------------------------------------------ | --------- | ------------------------------------------------------------------------ |
| `value`     | `string \| (() => string \| Promise<string>)`          | Required  | The text to copy, or a function that returns it.                         |
| `label`     | `string`                                               |           | A visible label. Without one, the button shows only the icon.            |
| `icon`      | `string`                                               |           | The icon before a copy, such as `i-lucide-link`. Defaults to the theme's `copy` icon. |
| `ariaLabel` | `string`                                               |           | The accessible name. Defaults to the label, or "Copy".                   |
| `size`      | `"xs" \| "sm" \| "md" \| "lg" \| "xl"`                 |           | The button size. Defaults to the theme size, `sm`.                       |
| `variant`   | `"ghost" \| "outline" \| "soft" \| "subtle" \| "solid" \| "link"` | `"ghost"` | The button variant. Use `outline` beside a primary action.     |

#### Events

| Event   | Payload | Description                                   |
| ------- | ------- | --------------------------------------------- |
| `copy`  | None    | The text is on the clipboard.                 |
| `error` | None    | The browser refused the write, or the function `value` failed. |

### useCopy

`useCopy(options?: { duration?: number }): { copy, copied, failed }`

| Return   | Type                                     | Description                                          |
| -------- | ---------------------------------------- | ---------------------------------------------------- |
| `copy`   | `(value: CopyValue) => Promise<boolean>` | Writes the text. Resolves to `true` when it copied.  |
| `copied` | `Readonly<Ref<boolean>>`                 | `true` for `duration` ms after a copy.               |
| `failed` | `Readonly<Ref<boolean>>`                 | `true` for `duration` ms after a refused copy.       |

## Related

- [Code Block](/docs/ui/code-block) uses `CopyButton` for `CodeBlockCopyButton`.
