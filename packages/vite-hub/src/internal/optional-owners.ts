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
    | "@vite-hub/realtime"
    | "@vite-hub/schedule"
    | "@vite-hub/workspace"

/**
 * The packages that the app installs for each feature, in `pnpm add` order. `vite-hub` declares each one as an optional
 * peer, so it resolves them from the app.
 */
export const optionalFeaturePackages = {
  "agent": ["@vite-hub/agent"],
  "auth": ["@vite-hub/auth", "better-auth"],
  "cms": ["@vite-hub/cms"],
  "comments": ["@vite-hub/comments"],
  // The Console journal of Agent Invocations.
  "console agents": ["@libsql/client", "drizzle-orm"],
  "console sign-in": ["@vite-hub/auth", "better-auth", "@better-auth/oauth-provider"],
  "content": ["@vite-hub/content"],
  // Database also needs `drizzle-kit` as a development dependency, which `@vite-hub/database` declares.
  "database": ["@vite-hub/database", "drizzle-orm"],
  "realtime": ["@vite-hub/realtime"],
  "schedule": ["@vite-hub/schedule"],
  "workspace": ["@vite-hub/workspace"],
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

/** The error for enabled features whose packages the app did not install. It lists one install command for all. */
export function missingFeaturePackagesError(features: readonly OptionalFeature[]) {
  const lines = features.map(feature => `The ${feature} feature needs ${optionalFeaturePackages[feature].join(", ")}.`)
  const missing = [...new Set(features.flatMap(feature => optionalFeaturePackages[feature]))].filter(name => !isPackageInstalled(name))
  return viteHubErrorDiagnostics.VITE_HUB_R0136({ message: `[vitehub] ${lines.join(" ")} Install the missing packages in your app with: pnpm add ${missing.join(" ")}` })
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
