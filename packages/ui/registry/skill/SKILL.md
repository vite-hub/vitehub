---
name: vitehub-ui
description: Build Vue or Nuxt interfaces with ViteHub UI. Use when you add a dialog, menu, select, tabs, form field, or any other part from `@vite-hub/kit`, style one, or install an item from the `@vitehub` registry.
---

# ViteHub UI

ViteHub UI has three layers. Each change goes to one of them:

| Layer | Where | Change it when |
| --- | --- | --- |
| Behavior | `@vite-hub/kit/<part>` (ui-sdk underneath) | keys, focus, or ARIA are wrong. Fix it upstream, never in the app |
| Look | the style family CSS and the tokens | a color, a radius, or a spacing is wrong |
| Your copy | files that `shadcn-vue add` wrote into the app | the app needs different markup or a variant |

## Use a part

1. Import the part from its own entry: `import { Dialog, DialogTrigger, DialogContent } from "@vite-hub/kit/dialog"`. There is no root entry. In Nuxt, add `@vite-hub/kit/nuxt` to `modules` and the parts auto-import.
2. Compose the parts the way the ui-sdk docs show (https://ui-sdk.dev). Props, events, and slots are ui-sdk's.
3. Check the result in a browser, with the keyboard: Tab, Enter, Escape, and the arrow keys.

## Style a part

- The look lives in CSS that targets `[data-slot="<part>"]` and state attributes such as `data-open`, `data-checked`, `data-highlighted`, and `data-disabled`. Style through those selectors, or through utility classes, which win over the family because it sits in the `components` layer.
- Take every color from the shadcn tokens: `var(--background)`, `var(--foreground)`, `var(--primary)`, `var(--muted-foreground)`, `var(--accent)`, `var(--border)`, `var(--input)`, `var(--ring)`. A new theme is new token values, never new selectors.
- Buttons take `data-variant="solid"` for the main action, `data-variant="ghost"` for toolbar and row actions, and `data-variant="destructive"`. The default is the outline button.
- Focus is the family's job: one 2px ring of `--ring`. Leave focus styles out of the app.

## Install from the registry

The `@vitehub` registry speaks the shadcn-vue format. Add it to `components.json` once:

```json
{ "registries": { "@vitehub": "https://vitehub.dev/r/{name}.json" } }
```

Then run `npx shadcn-vue@2.9 add @vitehub/<item>`, or pass the item URL. Install `@vitehub` items only: a stock shadcn-vue item brings Reka UI back into the app. A new app can start from `npx shadcn-vue@2.9 init --preset https://vitehub.dev/r/base.json`.

- `@vitehub/base`: the preset. It adds `theme` and `core`.
- `@vitehub/theme`: the tokens, written into the app's CSS.
- `@vitehub/core`: `vitehub.css` (the ui-sdk base CSS and the `--vh-*` tokens) and the live region helper. Every component item imports it.
- `@vitehub/status`, `@vitehub/copy-button`: Vue components. shadcn-vue writes them to `components/vitehub/<item>/`. Import from that folder, for example `import { CopyButton } from "@/components/vitehub/copy-button"`.
- `@vitehub/example-<item>`: one usage example for each component.
