import { defu } from "defu"

type DocsThemeUi = Record<string, unknown>

/** What Nuxt UI's `<UTheme>` takes: slot classes per component in `ui`, and default props per component in `props`. */
export interface DocsThemeScope {
  ui: Record<string, unknown>
  props: Record<string, unknown>
}

/**
 * The theme as `<UTheme>` props, for the docs pages of an app with its own `app.vue`. The app's `app.config.ts` then
 * stays as written on the app's own pages. `<UTheme>` sets slot classes and default props only, so the docs pages keep
 * the app's colors, icons, and variant classes, such as the color of a callout.
 */
export function docsThemeScope(theme: DocsThemeUi): DocsThemeScope {
  const scope: DocsThemeScope = { ui: {}, props: {} }
  for (const [name, entry] of Object.entries(theme)) {
    if (name === "colors" || name === "icons" || !isRecord(entry)) continue
    if (name === "prose") {
      const prose = docsThemeScope(entry)
      scope.ui.prose = prose.ui
      if (Object.keys(prose.props).length) scope.props.prose = prose.props
      continue
    }
    // A component with one element has a `base` class instead of slots, and reads it from `ui.base`.
    const slots = isRecord(entry.slots) ? entry.slots : typeof entry.base === "string" ? { base: entry.base } : null
    if (slots) scope.ui[name] = slots
    if (isRecord(entry.defaultVariants)) scope.props[name] = entry.defaultVariants
  }
  return scope
}

/** Resolve the live app config above the docs defaults, without adding a scope to standalone docs sites. */
export function resolveDocsTheme(scope: DocsThemeScope, ui: DocsThemeUi = {}): DocsThemeScope {
  if (!Object.keys(scope.ui).length && !Object.keys(scope.props).length) return scope
  return defu(docsThemeScope(ui), scope)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
