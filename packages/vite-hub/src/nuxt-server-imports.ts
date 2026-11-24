import { viteHubServerImports as serverImportTable } from "@vite-hub/internal/nuxt-server-imports"

/**
 * The server helpers that `vite-hub/nuxt` auto-imports in Nitro code, per ViteHub feature, when the app turns on
 * Nuxt's server auto-imports (see {@link nuxtServerAutoImportsEnabled}). The table lives in
 * `@vite-hub/internal/nuxt-server-imports`, so the `nuxt-server-imports` codemod reads the same list.
 *
 * The `satisfies` check fails the typecheck when a name is not a value export of its `vite-hub/*` entry.
 */
export const viteHubServerImports = serverImportTable satisfies Record<string, { [From in keyof ServerImportEntries]?: readonly (keyof ServerImportEntries[From] & string)[] }>

/** The public entries that the table imports from, mapped to their facade source. */
interface ServerImportEntries {
  "vite-hub/agent": typeof import("./agent.ts")
  "vite-hub/auth/server": typeof import("./auth/server.ts")
  "vite-hub/blob": typeof import("./blob.ts")
  "vite-hub/browser": typeof import("./browser.ts")
  "vite-hub/cache": typeof import("./cache.ts")
  "vite-hub/channels": typeof import("./channels.ts")
  "vite-hub/connections": typeof import("./connections.ts")
  "vite-hub/connections/server": typeof import("./connections/server.ts")
  "vite-hub/database": typeof import("./database.ts")
  "vite-hub/email": typeof import("./email.ts")
  "vite-hub/env": typeof import("./env.ts")
  "vite-hub/i18n/server": typeof import("./i18n/server.ts")
  "vite-hub/kv": typeof import("./kv.ts")
  "vite-hub/queue": typeof import("./queue.ts")
  "vite-hub/rate-limit": typeof import("./rate-limit.ts")
  "vite-hub/realtime": typeof import("./realtime.ts")
  "vite-hub/realtime/server": typeof import("./realtime/server.ts")
  "vite-hub/sandbox/task": typeof import("./sandbox/task.ts")
  "vite-hub/schedule": typeof import("./schedule.ts")
  "vite-hub/seo": typeof import("./seo.ts")
  "vite-hub/source": typeof import("./source.ts")
  "vite-hub/workflow": typeof import("./workflow.ts")
  "vite-hub/workspace": typeof import("./workspace.ts")
}

export type ViteHubServerImportFeature = keyof typeof viteHubServerImports

/** An unimport entry, as Nitro and Nuxt read `imports.imports`. */
export interface ServerAutoImport {
  as?: string
  from: string
  name: string
  priority?: number
}

/**
 * Whether the app turns on Nuxt's server auto-imports, with `experimental.nitroAutoImports` or `nitroLegacy.imports`
 * (`nitroLegacy: true` includes it). Nuxt 5 makes the same check before it adds the Nitro and H3 helpers.
 */
export function nuxtServerAutoImportsEnabled(options: { experimental?: { nitroAutoImports?: unknown }, nitroLegacy?: unknown }): boolean {
  if (options.experimental?.nitroAutoImports === true) return true
  const legacy = options.nitroLegacy
  if (legacy === true) return true
  if (typeof legacy !== "object" || legacy === null) return false
  return Boolean(("imports" in legacy ? legacy.imports : undefined) ?? true)
}

/** The import entries for the enabled features, in table order. */
export function resolveViteHubServerImports(enabled: Partial<Record<ViteHubServerImportFeature, unknown>>): ServerAutoImport[] {
  const imports: ServerAutoImport[] = []
  for (const [feature, sources] of Object.entries(viteHubServerImports)) {
    // SAFETY: `Object.entries` widens the keys of the const table above to string.
    if (!enabled[feature as ViteHubServerImportFeature]) continue
    for (const [from, names] of Object.entries(sources)) {
      // A negative priority lets the app's `server/utils` exports and other modules win a name without a warning.
      for (const name of names) imports.push({ from, name, priority: -1 })
    }
  }
  return imports
}
