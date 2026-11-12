import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { consoleFeaturePackages, features } from "@vite-hub/internal/features"
import { isPlainObject } from "@vite-hub/internal/object"
// The `semver` entry loads every one of its 47 modules. These three load a handful.
import satisfies from "semver/functions/satisfies.js"
import validVersion from "semver/functions/valid.js"
import validRange from "semver/ranges/valid.js"

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
    | "@vite-hub/comments"
    | "@vite-hub/connections"
    | "@vite-hub/content"
    | "@vite-hub/database"
    | "@vite-hub/decisions"
    | "@vite-hub/email"
    | "@vite-hub/forge"
    | "@vite-hub/forms"
    | "@vite-hub/gateways"
    | "@vite-hub/i18n"
    | "@vite-hub/kv"
    | "@vite-hub/markdown-template"
    | "@vite-hub/mcp"
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
  // The Agent Invocation components of `vite-hub/console/ui`.
  "console ui": ["@vite-hub/ui", "@json-render/core", "@json-render/vue", "@vueuse/core"],
  "content": ["@vite-hub/content"],
  // Database also needs `drizzle-kit` as a development dependency, which `@vite-hub/database` declares.
  "database": features.database.packages,
  "decisions": ["@vite-hub/decisions"],
  "email": features.email.packages,
  // `vite-hub/forge`: `useForge()` and the Forge helpers.
  "forge": ["@vite-hub/forge"],
  // `server/forms/` turns Forms on, and its submissions go to the Database.
  "forms": ["@vite-hub/forms"],
  "gateways": ["@vite-hub/gateways"],
  "i18n": features.i18n.packages,
  "kv": features.kv.packages,
  // `.template.md` imports and `vite-hub/markdown-template`.
  "markdown-template": ["@vite-hub/markdown-template"],
  "mcp": features.mcp.packages,
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
  try {
    import.meta.resolve(`${packageName}/package.json`)
    return true
  }
  catch (error) {
    // A missing package fails the same way for its entry. Each failed lookup walks every node_modules folder up to the
    // file system root, and most owner packages are missing in a typical app.
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") return false
  }
  // Some packages, such as drizzle-orm, do not export their manifest, so also try the package entry.
  try {
    import.meta.resolve(packageName)
    return true
  }
  catch {
    return false
  }
}

/**
 * Whether the app at `root` installed `packageName` in its own `node_modules` or one of its parents. `isPackageInstalled`
 * resolves from `vite-hub`, which also sees the development dependencies of a source checkout. `require.resolve` also
 * reads `NODE_PATH`, which pnpm bin scripts point at every hoisted package.
 */
export function isPackageInstalledInApp(root: string, packageName: string): boolean {
  for (let directory = resolve(root); ; directory = dirname(directory)) {
    if (existsSync(join(directory, "node_modules", packageName, "package.json"))) return true
    if (dirname(directory) === directory) return false
  }
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

/** Throws when an enabled feature misses one of its packages, and warns when an installed one is outside its range. */
export function assertFeaturePackages(features: readonly OptionalFeature[]): void {
  const missing = features.filter(feature => !optionalFeaturePackages[feature].every(isPackageInstalled))
  if (missing.length) throw missingFeaturePackagesError(missing)
  warnUnsupportedPackageVersions(features.flatMap(feature => optionalFeaturePackages[feature]))
}

/**
 * The `version` of the installed `packageName`, as `vite-hub` resolves it, from the manifest that names the package. It
 * is `undefined` when the package is missing or its manifest has no version.
 */
export function installedPackageVersion(packageName: string): string | undefined {
  let manifest: unknown
  try {
    manifest = readInstalledManifest(packageName)
  }
  catch {
    // The version check only warns, so a manifest that is not JSON does not stop the build.
    return undefined
  }
  return isPlainObject(manifest) && typeof manifest.version === "string" ? manifest.version : undefined
}

function readInstalledManifest(packageName: string): unknown {
  // A wildcard export can map `package.json` to a nested file, such as `{"type":"module"}` in the MCP SDK, and some
  // packages, such as drizzle-orm, do not export their manifest. Start at the file that resolves, and use the first
  // manifest above it that names the package.
  let file: string | undefined
  for (const specifier of [`${packageName}/package.json`, packageName]) {
    try {
      file = fileURLToPath(import.meta.resolve(specifier))
      break
    }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") return undefined
    }
  }
  if (file === undefined) return undefined
  for (let directory = dirname(file); dirname(directory) !== directory; directory = dirname(directory)) {
    const manifestFile = join(directory, "package.json")
    if (!existsSync(manifestFile)) continue
    const manifest: unknown = JSON.parse(readFileSync(manifestFile, "utf8"))
    if (isPlainObject(manifest) && manifest.name === packageName) return manifest
  }
}

/** Quotes `value` for a POSIX shell when it needs quotes, such as a range with `^`, `<`, or a space. */
function shellArgument(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The warning for installed packages whose version is outside the range in the `peerDependencies` of `vite-hub`, or
 * `undefined` when all are in range. A package without a version, or with a range that is not semver, such as
 * `workspace:*` in a source checkout, is not checked. A prerelease of a supported release line is in range.
 */
export function unsupportedPackageVersionsWarning(
  packages: readonly string[],
  versionOf: (packageName: string) => string | undefined = installedPackageVersion,
  manifest: unknown = readViteHubManifest(),
): string | undefined {
  const peers = isPlainObject(manifest) && isPlainObject(manifest.peerDependencies) ? manifest.peerDependencies : {}
  const unsupported = [...new Set(packages)].flatMap((name) => {
    const range = peers[name]
    if (typeof range !== "string" || validRange(range) === null) return []
    const version = versionOf(name)
    if (version === undefined || validVersion(version) === null || satisfies(version, range, { includePrerelease: true })) return []
    return [{ name, range, version }]
  })
  if (!unsupported.length) return undefined
  const viteHub = isPlainObject(manifest) && typeof manifest.version === "string" ? `vite-hub ${manifest.version}` : "vite-hub"
  const lines = unsupported.map(({ name, range, version }) => `${name} ${version} is installed, but ${viteHub} supports ${name}@${range}.`)
  // A preview of `vite-hub` gives a ViteHub package the preview URL. Other packages get the supported range.
  const previews = installArguments(unsupported.map(({ name }) => name), manifest)
  const install = unsupported.map(({ name, range }, index) => shellArgument(previews[index] === name ? `${name}@${range}` : previews[index]!))
  return `[vitehub] ${lines.join(" ")} Other versions can fail at runtime with errors that do not name the version. Update vite-hub to a release that supports these versions, or install supported versions in your app with: pnpm add ${install.join(" ")}`
}

const checkedPackageVersions = new Set<string>()
let viteHubManifest: unknown

/**
 * Prints the warning of `unsupportedPackageVersionsWarning` one time for each package in this process. The import
 * facades call `assertFeaturePackages` for each import, so a package is checked only the first time. The check only
 * warns, so a `vite-hub` manifest that it cannot read turns it off and does not stop the build.
 */
function warnUnsupportedPackageVersions(packages: readonly string[]): void {
  const unchecked = [...new Set(packages)].filter(name => !checkedPackageVersions.has(name))
  if (!unchecked.length) return
  for (const name of unchecked) checkedPackageVersions.add(name)
  if (viteHubManifest === undefined) {
    try {
      viteHubManifest = readViteHubManifest()
    }
    catch {
      viteHubManifest = null
    }
  }
  const warning = unsupportedPackageVersionsWarning(unchecked, installedPackageVersion, viteHubManifest)
  if (warning) console.warn(warning)
}

/** Returns the loaded owner module, or throws the install error of `feature`. */
export function requireOptionalOwner<T>(module: T | undefined, feature: OptionalFeature): T {
  if (module === undefined) throw missingFeaturePackagesError([feature])
  return module
}
