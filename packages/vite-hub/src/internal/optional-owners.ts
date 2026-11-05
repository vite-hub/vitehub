import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { features } from "@vite-hub/internal/features"
import { isPlainObject } from "@vite-hub/internal/object"

import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

/**
 * Owner packages that `vite-hub` declares as optional peers. An app installs only the packages of the features it
 * enables, so a Blob and Queue app does not install Agent, Auth, or editor dependencies.
 */
export type OptionalOwnerPackage
  = | "@vite-hub/agent"
    | "@vite-hub/auth"
    | "@vite-hub/cms"
    | "@vite-hub/comments"
    | "@vite-hub/content"
    | "@vite-hub/database"
    | "@vite-hub/presets"
    | "@vite-hub/realtime"
    | "@vite-hub/schedule"
    | "@vite-hub/shell"
    | "@vite-hub/ui"
    | "@vite-hub/workspace"

/**
 * The packages that the app installs for each feature, in `pnpm add` order. `vite-hub` declares each one as an optional
 * peer, so it resolves them from the app. Features in the catalog of `@vite-hub/internal/features` read their packages
 * from it.
 */
export const optionalFeaturePackages = {
  "agent": features.agent.packages,
  "auth": features.auth.packages,
  "cms": ["@vite-hub/cms"],
  "comments": features.comments.packages,
  // Connections store grants in the default Database and turn `database` on.
  "connections": features.connections.packages,
  // The Console journal of Agent Invocations.
  "console agents": ["@libsql/client", "drizzle-orm"],
  "console sign-in": ["@vite-hub/auth", "better-auth", "@better-auth/oauth-provider"],
  "content": ["@vite-hub/content"],
  // Database also needs `drizzle-kit` as a development dependency, which `@vite-hub/database` declares.
  "database": features.database.packages,
  "presets": ["@vite-hub/presets", "@vite-hub/agent"],
  "realtime": features.realtime.packages,
  "schedule": features.schedule.packages,
  "shell": ["@vite-hub/shell"],
  "ui": ["@vite-hub/ui"],
  "workspace": features.workspace.packages,
} as const satisfies Record<string, readonly string[]>

export type OptionalFeature = keyof typeof optionalFeaturePackages

/** Whether the app installed `packageName`, as `vite-hub` resolves it. */
export function isPackageInstalled(packageName: string): boolean {
  // Some packages, such as drizzle-orm, do not export their manifest, so also try the package entry.
  return [`${packageName}/package.json`, packageName].some((specifier) => {
    try {
      import.meta.resolve(specifier)
      return true
    }
    catch {
      return false
    }
  })
}

/** Loads a module of an optional owner package, or returns `undefined` when the app did not install the package. */
export async function importOptionalOwner<T>(packageName: OptionalOwnerPackage, load: () => Promise<T>): Promise<T | undefined> {
  return isPackageInstalled(packageName) ? await load() : undefined
}

/**
 * The `pnpm add` arguments for `packages`. A pkg.pr.new preview of `vite-hub` keeps the npm version in its optional
 * peers, so a plain name installs the npm release. The preview's own `@vite-hub/*` dependencies point at pkg.pr.new, so
 * the other ViteHub packages get the URL of the same preview.
 */
export function installArguments(packages: readonly string[], manifest: unknown = readViteHubManifest()): string[] {
  const dependencies = isPlainObject(manifest) && isPlainObject(manifest.dependencies) ? manifest.dependencies : {}
  const preview = Object.entries(dependencies).flatMap(([name, specifier]) => {
    if (!name.startsWith("@vite-hub/") || typeof specifier !== "string" || !specifier.startsWith("https://pkg.pr.new/")) return []
    const [base, ref] = specifier.split(`/${name}@`)
    return base && ref ? [{ base, ref }] : []
  })[0]
  return packages.map(name => preview && name.startsWith("@vite-hub/") ? `${preview.base}/${name}@${preview.ref}` : name)
}

function readViteHubManifest(): unknown {
  return JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("vite-hub/package.json")), "utf8"))
}

/** The error for enabled features whose packages the app did not install. It lists one install command for all. */
export function missingFeaturePackagesError(features: readonly OptionalFeature[]) {
  const lines = features.map(feature => `The ${feature} feature needs ${optionalFeaturePackages[feature].join(", ")}.`)
  const missing = [...new Set(features.flatMap(feature => optionalFeaturePackages[feature]))].filter(name => !isPackageInstalled(name))
  return viteHubErrorDiagnostics.VITE_HUB_R0136({ message: `[vitehub] ${lines.join(" ")} Install the missing packages in your app with: pnpm add ${installArguments(missing).join(" ")}` })
}

/** Throws when an enabled feature misses one of its packages. */
export function assertFeaturePackages(features: readonly OptionalFeature[]): void {
  const missing = features.filter(feature => !optionalFeaturePackages[feature].every(isPackageInstalled))
  if (missing.length) throw missingFeaturePackagesError(missing)
}

/** Returns the loaded owner module, or throws the install error of `feature`. */
export function requireOptionalOwner<T>(module: T | undefined, feature: OptionalFeature): T {
  if (module === undefined) throw missingFeaturePackagesError([feature])
  return module
}
