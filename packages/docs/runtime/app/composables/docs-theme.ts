import theme from "#docs/theme"

import { resolveDocsTheme } from "../utils/docs-theme"

/**
 * The `ui` prop of a Nuxt UI component in the shell, with the design's classes for the same slots in front. In an app
 * with its own `app.vue`, `<UTheme>` gives the docs components the design, but a component's own `ui` prop replaces a
 * `<UTheme>` slot instead of adding to it. In a docs site the design is in the app config, and this returns `ui` as is.
 */
export function withDocsTheme<T extends Record<string, string | undefined>>(component: string, ui: T): T {
  if (!theme.ui[component]) return ui
  const design = resolveDocsTheme(theme, useAppConfig().ui).ui[component] as Record<string, string | undefined>
  return Object.fromEntries(Object.entries(ui).map(([slot, classes]) => [slot, [design[slot], classes].filter(Boolean).join(" ") || undefined])) as T
}
