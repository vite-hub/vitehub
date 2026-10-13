import { readonly, ref } from "vue"
import type { InjectionKey, Ref } from "vue"

export type ConsoleAppearance = "system" | "light" | "dark"
export type ConsoleColorScheme = "light" | "dark"

export interface ConsoleAppearanceController {
  readonly preference: Readonly<Ref<ConsoleAppearance>>
  select(appearance: ConsoleAppearance): void
}

export const consoleAppearances: readonly ConsoleAppearance[] = ["system", "light", "dark"]

export const consoleAppearanceOptions: Readonly<Record<ConsoleAppearance, { icon: string, label: string }>> = {
  system: { icon: "i-lucide-monitor", label: "System" },
  light: { icon: "i-lucide-sun", label: "Light" },
  dark: { icon: "i-lucide-moon", label: "Dark" },
}

interface ConsoleAppearanceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface ConsoleColorSchemeQuery {
  readonly matches: boolean
  addEventListener(type: "change", listener: () => void): void
}

interface ConsoleAppearanceRoot {
  readonly classList: { toggle(token: string, force?: boolean): boolean }
}

interface ConsoleThemeColorMeta {
  readonly dataset?: { readonly vitehubConsoleTheme?: string }
  media: string
}

interface ConsoleThemeColorDocument {
  querySelectorAll(selector: string): ArrayLike<ConsoleThemeColorMeta>
}

const consoleAppearanceStorageKey = "vitehub-console:appearance"

/** Media query that reports a dark system color scheme. */
export const consoleDarkSchemeQuery: string = "(prefers-color-scheme: dark)"

/** Returns the stored preference. Missing or unknown values follow the system. */
export function parseConsoleAppearance(value: string | null | undefined): ConsoleAppearance {
  return value === "light" || value === "dark" ? value : "system"
}

export function readConsoleAppearance(storage?: ConsoleAppearanceStorage): ConsoleAppearance {
  try {
    const target = storage ?? globalThis.localStorage
    return parseConsoleAppearance(target?.getItem(consoleAppearanceStorageKey))
  }
  catch {
    return "system"
  }
}

export function rememberConsoleAppearance(appearance: ConsoleAppearance, storage?: ConsoleAppearanceStorage): void {
  try {
    const target = storage ?? globalThis.localStorage
    target?.setItem(consoleAppearanceStorageKey, appearance)
  }
  catch {
    // Browser privacy settings can disable local storage. The choice still applies to this page.
  }
}

export function resolveConsoleColorScheme(appearance: ConsoleAppearance, systemDark: boolean): ConsoleColorScheme {
  if (appearance !== "system") return appearance
  return systemDark ? "dark" : "light"
}

/** Sets exactly one of `light` or `dark`. An explicit class overrides the `prefers-color-scheme` fallback in styles.css. */
export function applyConsoleColorScheme(root: ConsoleAppearanceRoot, scheme: ConsoleColorScheme): void {
  root.classList.toggle("dark", scheme === "dark")
  root.classList.toggle("light", scheme === "light")
}

/** Keeps browser chrome and PWA title bars in sync with the selected scheme. */
export function applyConsoleThemeColor(
  document: ConsoleThemeColorDocument | undefined,
  scheme: ConsoleColorScheme | "system",
): void {
  if (!document) return
  for (const meta of Array.from(document.querySelectorAll('meta[name="theme-color"][data-vitehub-console-theme]'))) {
    const theme = meta.dataset?.vitehubConsoleTheme
    if (theme !== "light" && theme !== "dark") continue
    meta.media = scheme === "system"
      ? `(prefers-color-scheme: ${theme})`
      : theme === scheme ? "" : "not all"
  }
}

/**
 * Applies the stored preference to `root` and keeps it current.
 * The "system" preference follows `query` when the system scheme changes.
 */
export function startConsoleAppearance(options: {
  query: ConsoleColorSchemeQuery
  root: ConsoleAppearanceRoot
  storage?: ConsoleAppearanceStorage
  themeColorDocument?: ConsoleThemeColorDocument
}): ConsoleAppearanceController {
  const preference = ref(readConsoleAppearance(options.storage))
  const apply = () => {
    const scheme = resolveConsoleColorScheme(preference.value, options.query.matches)
    applyConsoleColorScheme(options.root, scheme)
    applyConsoleThemeColor(
      options.themeColorDocument,
      preference.value,
    )
  }
  apply()
  options.query.addEventListener("change", apply)
  return {
    preference: readonly(preference),
    select(appearance: ConsoleAppearance): void {
      preference.value = appearance
      rememberConsoleAppearance(appearance, options.storage)
      apply()
    },
  }
}

/**
 * Only the standalone Console app provides this. In a Nuxt host the application owns color mode,
 * so Console components leave it alone when nothing is provided.
 */
export const consoleAppearanceKey: InjectionKey<ConsoleAppearanceController> = Symbol("vitehub-console-appearance")
