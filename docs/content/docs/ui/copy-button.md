---
title: Copy Button
description: "Copy a command, an ID, or a link with one button that confirms in place and announces the result."
navigation.order: 16
navigation.group: Parts
icon: i-lucide-copy
---

`CopyButton` copies text to the clipboard. After a copy its icon swaps to a check for 2 seconds, its label changes to "Copied", and it tells screen readers "Copied". It is a Nuxt UI `UButton` with the theme defaults: neutral, ghost, and icon-only unless you give it a label.

::example{name="CopyButtonExample" height=8}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports `CopyButton`. In Vue with Vite, import it from `vite-hub/ui`:

```ts
import { CopyButton, useCopy } from "vite-hub/ui";
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

`value` can also be a function. Use one when the text is expensive or must load first, such as the Markdown of a page. The button shows the loading icon until the text is ready. Add `preload` to call the function when the pointer enters the button or the button gets focus, so the text is usually ready before the click:

```vue
<template>
  <CopyButton :value="() => $fetch('/raw/page.md', { responseType: 'text' })" preload label="Copy page" variant="outline" />
</template>
```

Each hover or focus loads the text once, for the next click. When that load fails, the click calls the function again. Without `preload`, the function runs only on click.

Set `duration` to change how long the check shows, in ms:

```vue
<template>
  <CopyButton :value="apiKey" :duration="4000" aria-label="Copy the API key" />
</template>
```

## Copy from a menu

A menu item that copies is not a button. Use `useCopy()`, the same clipboard logic, and confirm with a toast:

```ts
import { useToast } from "@nuxt/ui/composables";
import { useCopy } from "vite-hub/ui";

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

`copy(value)` resolves to `true` when the text is on the clipboard, and `false` when the browser refused. It never rejects. `copied` and `failed` stay `true` for 2 seconds, or for the `duration` that you pass in ms. A ref or a getter is read at each copy.

## Animation

After a copy, the copy icon blurs out and the check draws its stroke in. A button with a label changes it to `copiedLabel`, "Copied" by default, letter by letter: the letters that both labels share stay, and the button's width follows the letters with a spring. The button then rings once. When `duration` ends, the icon and the label change back the same way, with no ring. While a function `value` loads, the spinner draws in where the icon was. A copy in the middle of a swap continues from where it is. Nothing animates on page load.

The motion comes from the motion layer and the helpers of `@vite-hub/ui/motion` (see [docs/design/motion.md](https://github.com/vite-hub/vitehub/blob/main/docs/design/motion.md)). With reduced motion turned on in the system, the icon and the label crossfade in 150ms and there is no ring.

## Without Vue

A page with a script uses the same helpers: `swapIcon(container, icon, { enter: "draw" })` for the icon, `morphText(label, "Copied")` for the label, and `ring(button)` when the copy finished, all from `@vite-hub/ui/motion`.

A page that runs no script of ours, such as a document in a cross-origin frame, can load `@vite-hub/ui/icon-swap.css`, a plain CSS cross-fade of the two icons, or read it as text with `?raw`:

```ts
import iconSwap from "@vite-hub/ui/icon-swap.css?raw";

const style = document.createElement("style");
style.textContent = iconSwap;
document.head.append(style);
```

```html
<button type="button" data-slot="copy-button" aria-label="Copy">
  <span data-slot="copy-button-icon" aria-hidden="true">
    <span data-icon="copy"><svg><!-- the copy icon --></svg></span>
    <span data-icon="check"><svg><!-- the check icon --></svg></span>
  </span>
  Copy
</button>
```

- `data-slot="copy-button-icon"` holds the two icons.
- `data-icon="copy"` wraps the icon before a copy, and `data-icon="check"` the icon after it. The swap animates the wrappers, so the icons keep their own classes.
- Set `data-copied` on the button after a copy, and remove it to swap back. The rules match `data-copied` on any element around the icons.
- The page announces the result itself, for example in a polite live region.

## Features

- The icon swaps from `copy`, or the `icon` prop, to `copyCheck` of Nuxt UI's `appConfig.ui.icons`, so the button follows the theme.
- The button announces "Copied" or "Copy failed" through a polite live region. Inside a dialog, the region is in the dialog, so the screen reader still reads it.
- Outside a secure context, such as a dev server on a LAN address, the clipboard API is missing or refuses. The button then copies with the older `document.execCommand("copy")`.
- A clipboard that the browser blocks does not throw. The button keeps the copy icon, announces "Copy failed", and emits `error`.
- A function `value` that returns a promise copies through a `ClipboardItem` where the browser has one, so Safari accepts the write after the click. With `preload`, the click writes the text that already loaded, or passes the pending load to the `ClipboardItem`.

## Accessibility

The button is named "Copy" when it has no label and no `aria-label`. Give an icon-only button an `aria-label` that names the thing, such as "Copy run ID", when more than one copy button is on the page. An `aria-label` does not change after a copy. A button named by its label reads "Copied" until `duration` ends. The result is also announced, so focus stays where it is.

## API Reference

### CopyButton

Renders a Nuxt UI `UButton` with `data-slot="copy-button"`, and `data-copied` for `duration` ms after a copy. Its leading slot holds a `SwapIcon` in `data-slot="swap-icon"`: the copy icon, the spinner while the text loads, or the check. Other attributes, such as `class` and `color`, pass to the button.

#### Props

| Prop        | Type                                                   | Default   | Description                                                              |
| ----------- | ------------------------------------------------------ | --------- | ------------------------------------------------------------------------ |
| `value`     | `string \| (() => string \| Promise<string>)`          | Required  | The text to copy, or a function that returns it.                         |
| `label`     | `string`                                               |           | A visible label. Without one, the button shows only the icon.            |
| `copiedLabel` | `string`                                             | `"Copied"` | The label for `duration` ms after a copy, when the button has a label.  |
| `icon`      | `string`                                               |           | The icon before a copy, such as `i-lucide-link`. Defaults to the theme's `copy` icon. |
| `ariaLabel` | `string`                                               |           | The accessible name. Defaults to the label, or "Copy".                   |
| `size`      | `"xs" \| "sm" \| "md" \| "lg" \| "xl"`                 |           | The button size. Defaults to the theme size, `sm`.                       |
| `variant`   | `"ghost" \| "outline" \| "soft" \| "subtle" \| "solid" \| "link"` | `"ghost"` | The button variant. Use `outline` beside a primary action.     |
| `duration`  | `number`                                               | `2000`    | How long, in ms, the check shows after a copy.                           |
| `preload`   | `boolean`                                              | `false`   | Call a function `value` on pointer enter and on focus, so the click copies text that already loaded. |

#### Events

| Event   | Payload | Description                                   |
| ------- | ------- | --------------------------------------------- |
| `copy`  | None    | The text is on the clipboard.                 |
| `error` | None    | The browser refused the write, or the function `value` failed. |

### useCopy

`useCopy(options?: { duration?: MaybeRefOrGetter<number> }): { copy, copied, failed }`

| Return   | Type                                     | Description                                          |
| -------- | ---------------------------------------- | ---------------------------------------------------- |
| `copy`   | `(value: CopyValue) => Promise<boolean>` | Writes the text. Resolves to `true` when it copied.  |
| `copied` | `Readonly<Ref<boolean>>`                 | `true` for `duration` ms after a copy.               |
| `failed` | `Readonly<Ref<boolean>>`                 | `true` for `duration` ms after a refused copy.       |

## Related

- [Code Block](/docs/ui/code-block) uses `CopyButton` for `CodeBlockCopyButton`.
