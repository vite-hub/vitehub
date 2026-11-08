import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { consoleFeaturePackages, features } from "@vite-hub/internal/features"
import { isPlainObject } from "@vite-hub/internal/object"

import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

/**
 * Owner packages that `vite-hub` declares as optional peers. An app installs only the packages of the features it
 * enables, so an app without features installs none of them, and a KV app does not install Blob, Queue, or Agent.
 */
export type OptionalOwnerPackage
  = | "@vite-hub/agent"
    | "@vite-hub/auth"
    | "@vite-hub/blob"
    | "@vite-hub/browser"
    | "@vite-hub/channels"
    | "@vite-hub/cms"
    | "@vite-hub/codemods"
    | "@vite-hub/comments"
    | "@vite-hub/connections"
    | "@vite-hub/content"
    | "@vite-hub/database"
    | "@vite-hub/decisions"
    | "@vite-hub/email"
    | "@vite-hub/gateways"
    | "@vite-hub/kv"
    | "@vite-hub/markdown-template"
    | "@vite-hub/presets"
    | "@vite-hub/queue"
    | "@vite-hub/rate-limit"
    | "@vite-hub/realtime"
    | "@vite-hub/sandbox"
    | "@vite-hub/schedule"
    | "@vite-hub/shell"
    | "@vite-hub/ui"
    | "@vite-hub/workflow"
    | "@vite-hub/workspace"

/**
 * The packages that the app installs for each feature, in `pnpm add` order. `vite-hub` declares each one as an optional
 * peer, so it resolves them from the app. Features in the catalog of `@vite-hub/internal/features` read their packages
 * from it.
 */
export const optionalFeaturePackages = {
  "agent": features.agent.packages,
  "auth": features.auth.packages,
  "blob": features.blob.packages,
  "browser": features.browser.packages,
  "channels": features.channels.packages,
  "cms": ["@vite-hub/cms"],
  "comments": features.comments.packages,
  // Connections store grants in the default Database and turn `database` on.
  "connections": features.connections.packages,
  // The Console reads the Agent Invocation journal with libSQL, and its /debug command with Drizzle.
  "console agents": consoleFeaturePackages.agents,
  // `console: { mcpClient: true }` connects the Console to MCP servers.
  "console mcp-client": ["@modelcontextprotocol/sdk"],
  "console sign-in": consoleFeaturePackages.signIn,
  // The Agent Invocation components of `vite-hub/console/ui`.
  "console ui": ["@vite-hub/ui", "@json-render/core", "@json-render/vue", "@vueuse/core"],
  "content": ["@vite-hub/content"],
  // Database also needs `drizzle-kit` as a development dependency, which `@vite-hub/database` declares.
  "database": features.database.packages,
  "decisions": ["@vite-hub/decisions"],
  "email": features.email.packages,
  "gateways": ["@vite-hub/gateways"],
  "kv": features.kv.packages,
  // `.template.md` imports and `vite-hub/markdown-template`.
  "markdown-template": ["@vite-hub/markdown-template"],
  // `vitehub migrate` runs its codemods. Install it as a development dependency.
  "migrate": ["@vite-hub/codemods"],
  "presets": ["@vite-hub/presets", "@vite-hub/agent"],
  "queue": features.queue.packages,
  "rateLimit": features.rateLimit.packages,
  "realtime": features.realtime.packages,
  "sandboxTask": features.sandboxTask.packages,
  "schedule": features.schedule.packages,
  "shell": ["@vite-hub/shell"],
  "ui": ["@vite-hub/ui"],
  // An Agent turns Workflow on unless the app sets `workflow: false`.
  "workflow": features.workflow.packages,
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
