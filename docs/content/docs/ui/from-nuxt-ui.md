---
title: Migrate from Nuxt UI
description: "What works today when a Nuxt UI app adds ui-sdk parts, ViteHub forms, and the page Capability, and what waits for a later plan."
navigation.title: From Nuxt UI
navigation.order: 5
navigation.group: Start
icon: i-lucide-arrow-right-left
---

ViteHub UI does not replace Nuxt UI yet. The [AI components](/docs/ui/ai-components) and the ViteHub Console are built on Nuxt UI, and they stay on it for now. You can add ui-sdk parts to a Nuxt UI app one page at a time.

## Works today

- **ui-sdk parts next to Nuxt UI.** Add `@ui-sdk/vue/nuxt` to `modules`, and use `<Dialog>` next to `<UButton>`. The names do not collide, because Nuxt UI parts start with `U`. For the part that replaces a Nuxt UI part, see [From Reka UI](/docs/ui/from-reka-ui): most Nuxt UI parts wrap a Reka UI part.
- **Styles with classes.** Style ui-sdk parts with Tailwind CSS classes and the Nuxt UI tokens, such as `data-open:bg-elevated`.
- **Forms.** [`useFormAction()`](/docs/forms/vue) sends a native `<form>`, whatever draws its controls, and `AutoForm` needs no Nuxt UI.
- **The page Capability.** The Agent reads and changes only the parts that ui-sdk registers. It does not see Nuxt UI parts, so move the controls that the Agent works to ui-sdk parts first.

## Not yet

- **A style family in a Nuxt UI app.** The kit family and Nuxt UI both style parts by `data-slot`, and 8 slot names are the same: `avatar`, `button`, `checkbox`, `input`, `label`, `progress`, `separator`, and `toggle`. Each one restyles the other, so do not load `@vite-hub/kit/styles/default.css` in an app with Nuxt UI.
- **A codemod** from `U*` components to ui-sdk parts.
- **AI components without Nuxt UI.**

The Nuxt UI exit is a later plan. It starts when the style family works next to Nuxt UI, and this page will then show each step.
