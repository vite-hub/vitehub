import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { formatDiagnostic } from "nostics"

import type { ViteHubHost } from "@vite-hub/internal/deployment"
import type { FeatureId } from "@vite-hub/internal/features"
import { consoleFeaturePackages, featureIds, featurePackages, features } from "@vite-hub/internal/features"
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
    | "@vite-hub/device"
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
    | "@vite-hub/sync"
    | "@vite-hub/ui"
    | "@vite-hub/webhooks"
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
  // `vite-hub/device`: stored reads in the browser.
  "device": ["@vite-hub/device"],
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
  // `vitehub migrate` runs its codemods. Install it as a development dependency.
  "migrate": ["@vite-hub/codemods"],
  "presets": ["@vite-hub/presets", "@vite-hub/agent"],
  "queue": features.queue.packages,
  "rateLimit": features.rateLimit.packages,
  "realtime": features.realtime.packages,
  "sandboxTask": features.sandboxTask.packages,
  "schedule": features.schedule.packages,
  "shell": ["@vite-hub/shell"],
  // `server/sync/` turns Sync on, and its change log goes to the Database.
  "sync": ["@vite-hub/sync"],
  "ui": ["@vite-hub/ui"],
  // `server/webhooks/` turns Webhooks on. It needs `queue` and `database`.
  "webhooks": ["@vite-hub/webhooks"],
  "workflow": features.workflow.packages,
  "workspace": features.workspace.packages,
} as const satisfies Record<string, readonly string[]>

export type OptionalFeature = keyof typeof optionalFeaturePackages

/**
 * The results of `isPackageInstalled` in this process. Each lookup resolves from `vite-hub` itself, so the package name
 * is the key. A dev start asks for the same packages two or three times, and most of them are missing.
 */
const packageChecks = new Map<string, boolean>()

/** Whether the app installed `packageName`, as `vite-hub` resolves it. The result stays until `forgetPackageChecks`. */
export function isPackageInstalled(packageName: string): boolean {
  let installed = packageChecks.get(packageName)
  if (installed === undefined) {
    installed = resolvesPackage(packageName)
    packageChecks.set(packageName, installed)
  }
  return installed
}

/**
 * Forgets the results of `isPackageInstalled`, so that the next check sees the packages that the app installed or
 * removed since then. The `vite-hub/dependencies` plugin calls it when the dev server or the build closes.
 */
export function forgetPackageChecks(): void {
  packageChecks.clear()
}

let startedPackageChecks = false

/**
 * Forgets the results of an earlier start. `vitehub()` calls it each time Vite loads the app config, and the Nuxt module
 * calls it when Nuxt asks for its dependencies, first on each start. A Vite restart creates the new server before it
 * closes the old one, so `closeBundle` comes after the config hooks of the new server. A Nuxt start that fails before
 * Vite starts closes no plugin. The first start keeps the results of the checks that the import of `vite-hub` made.
 */
export function startPackageChecks(): void {
  if (startedPackageChecks) forgetPackageChecks()
  startedPackageChecks = true
}

function resolvesPackage(packageName: string): boolean {
  try {
    import.meta.resolve(`${packageName}/package.json`)
    return true
  }
  catch (error) {
    // A missing package fails the same way for its entry. Each failed lookup walks every node_modules folder up to the
    // file system root, and most owner packages are missing in a typical app.
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") return false
  }
  // Some packages, such as drizzle-orm, do not export their manifest, so also try the package entry
  // (drizzle-orm: https://github.com/drizzle-team/drizzle-orm/issues/6695).
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

/**
 * Packages that the host or a provider adds to a feature, such as `@vercel/queue` for Queue on Vercel. They are optional
 * peers of the feature's owner package, which loads them, so the check resolves them from that owner.
 */
export type FeatureHostPackages = Partial<Record<OptionalFeature, readonly string[]>>

/**
 * The packages that each feature in `enabled` adds on `host` with its option value in `options`. `vitehub add` and
 * `vitehub status` read the same catalog, so the build asks for the packages that the CLI installs.
 */
export function hostFeaturePackages(enabled: readonly OptionalFeature[], host: ViteHubHost, options: object): FeatureHostPackages {
  return Object.fromEntries(enabled.flatMap((feature) => {
    if (!isFeatureId(feature)) return []
    const added = featurePackages(feature, Reflect.get(options, feature), host).filter(name => !optionalFeaturePackages[feature].includes(name))
    return added.length ? [[feature, added]] : []
  }))
}

function isFeatureId(feature: OptionalFeature): feature is OptionalFeature & FeatureId {
  return featureIds.some(id => id === feature)
}

function packagesOf(feature: OptionalFeature, hostPackages: FeatureHostPackages): string[] {
  return [...new Set([...optionalFeaturePackages[feature], ...hostPackages[feature] ?? []])]
}

/** Whether `packageName` is installed where the feature loads it: from `vite-hub` for its own peers, else from the owner. */
function isFeaturePackageInstalled(feature: OptionalFeature, packageName: string): boolean {
  const own: readonly string[] = optionalFeaturePackages[feature]
  if (own.includes(packageName)) return isPackageInstalled(packageName)
  return isPackageInstalled(packageName) || isPackageInstalledFrom(own[0]!, packageName)
}

/** Whether `owner` resolves `packageName`. pnpm links an optional peer only into the packages that declare it. */
function isPackageInstalledFrom(owner: string, packageName: string): boolean {
  const key = `${owner}>${packageName}`
  let installed = packageChecks.get(key)
  if (installed === undefined) {
    installed = resolvesPackageFrom(owner, packageName)
    packageChecks.set(key, installed)
  }
  return installed
}

function isModuleNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_MODULE_NOT_FOUND")
}

function resolvesPackageFrom(owner: string, packageName: string): boolean {
  let ownerFile: string
  try {
    ownerFile = fileURLToPath(import.meta.resolve(`${owner}/package.json`))
  }
  catch {
    return false
  }
  try {
    createRequire(ownerFile).resolve(`${packageName}/package.json`)
    return true
  }
  catch (error) {
    // A package that does not export its manifest is still installed.
    return !isModuleNotFound(error)
  }
}

/**
 * The error for enabled features whose packages the app did not install. It lists one install command for every package
 * that it names. A package that another dependency happens to provide is still an optional peer of `vite-hub`, so the
 * app installs it too.
 */
export function missingFeaturePackagesError(features: readonly OptionalFeature[], hostPackages: FeatureHostPackages = {}) {
  const lines = features.map(feature => `The ${feature} feature needs ${packagesOf(feature, hostPackages).join(", ")}.`)
  const packages = [...new Set(features.flatMap(feature => packagesOf(feature, hostPackages)))]
  return viteHubErrorDiagnostics.VITE_HUB_R0136({ message: `[vitehub] ${lines.join(" ")} Install them in your app with: pnpm add ${installArguments(packages).join(" ")}` })
}

/**
 * Throws when an enabled feature misses one of its packages or has a ViteHub package outside the range of `vite-hub`,
 * and warns when another installed package is outside its range. `hostPackages` adds the packages that the host or a
 * provider needs, from `hostFeaturePackages`.
 */
export function assertFeaturePackages(features: readonly OptionalFeature[], hostPackages: FeatureHostPackages = {}): void {
  const isMissing = (feature: OptionalFeature) => !packagesOf(feature, hostPackages).every(name => isFeaturePackageInstalled(feature, name))
  if (features.some(isMissing)) {
    // The app can install a package after an earlier check, such as after this error in a dev session. Check again.
    forgetPackageChecks()
    const missing = features.filter(isMissing)
    if (missing.length) throw missingFeaturePackagesError(missing, hostPackages)
  }
  checkPackageVersions(features.flatMap(feature => packagesOf(feature, hostPackages)))
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
 * Installed packages whose version is outside the range in the `peerDependencies` of `vite-hub`, with the sentences
 * that name them and the `pnpm add` arguments that install supported versions. A package without a version, or with a
 * range that is not semver, such as `workspace:*` in a source checkout, is not checked. A prerelease of a supported
 * release line is in range.
 */
function unsupportedPackageVersions(
  packages: readonly string[],
  versionOf: (packageName: string) => string | undefined,
  manifest: unknown,
): { install: string, installed: string } | undefined {
  const peers = isPlainObject(manifest) && isPlainObject(manifest.peerDependencies) ? manifest.peerDependencies : {}
  const { satisfies, validRange, validVersion } = semverFunctions()
  const unsupported = [...new Set(packages)].flatMap((name) => {
    const range = peers[name]
    if (typeof range !== "string" || validRange(range) === null) return []
    const version = versionOf(name)
    if (version === undefined || validVersion(version) === null || satisfies(version, range, { includePrerelease: true })) return []
    return [{ name, range, version }]
  })
  if (!unsupported.length) return undefined
  const viteHub = isPlainObject(manifest) && typeof manifest.version === "string" ? `vite-hub ${manifest.version}` : "vite-hub"
  const installed = unsupported.map(({ name, range, version }) => `${name} ${version} is installed, but ${viteHub} supports ${name}@${range}.`).join(" ")
  // A preview of `vite-hub` gives a ViteHub package the preview URL. Other packages get the supported range.
  const previews = installArguments(unsupported.map(({ name }) => name), manifest)
  const install = unsupported.map(({ name, range }, index) => shellArgument(previews[index] === name ? `${name}@${range}` : previews[index]!)).join(" ")
  return { install, installed }
}

const isViteHubPackage = (name: string) => name.startsWith("@vite-hub/")

/**
 * The error for installed ViteHub packages outside the range of `vite-hub`, or `undefined` when all are in range.
 * ViteHub packages of another release share internal contracts with `vite-hub` that can change in any commit.
 */
export function unsupportedViteHubPackagesError(
  packages: readonly string[],
  versionOf: (packageName: string) => string | undefined = installedPackageVersion,
  manifest: unknown = readViteHubManifest(),
): ReturnType<typeof viteHubErrorDiagnostics.VITE_HUB_PACKAGE_VERSION_UNSUPPORTED> | undefined {
  const unsupported = unsupportedPackageVersions(packages.filter(isViteHubPackage), versionOf, manifest)
  return unsupported && viteHubErrorDiagnostics.VITE_HUB_PACKAGE_VERSION_UNSUPPORTED(unsupported)
}

/** The warning for other installed packages outside the range of `vite-hub`, or `undefined` when all are in range. */
export function unsupportedPackageVersionsWarning(
  packages: readonly string[],
  versionOf: (packageName: string) => string | undefined = installedPackageVersion,
  manifest: unknown = readViteHubManifest(),
): string | undefined {
  const unsupported = unsupportedPackageVersions(packages.filter(name => !isViteHubPackage(name)), versionOf, manifest)
  return unsupported && `[vitehub] ${unsupported.installed} Other versions can fail at runtime with errors that do not name the version. Update vite-hub to a release that supports these versions, or install supported versions in your app with: pnpm add ${unsupported.install}`
}

interface SemverFunctions {
  satisfies: typeof import("semver/functions/satisfies.js")
  validRange: typeof import("semver/ranges/valid.js")
  validVersion: typeof import("semver/functions/valid.js")
}

let semver: SemverFunctions | undefined

/**
 * Loads semver when a version check runs, so `vite-hub/nuxt` starts without it. The `semver` entry loads every one of
 * its 47 modules. These three load a handful.
 */
function semverFunctions(): SemverFunctions {
  if (semver) return semver
  const require = createRequire(import.meta.url)
  semver = {
    satisfies: require("semver/functions/satisfies.js"),
    validRange: require("semver/ranges/valid.js"),
    validVersion: require("semver/functions/valid.js"),
  }
  return semver
}

const checkedPackageVersions = new Set<string>()
let viteHubManifest: unknown

/**
 * Throws the error of `unsupportedViteHubPackagesError`, and prints the warning of `unsupportedPackageVersionsWarning`
 * one time for each package in this process. The import facades call `assertFeaturePackages` for each import, so a
 * package in range is checked only the first time. A package out of range stays unchecked, so the next check throws
 * again until the app installs a supported version. A `vite-hub` manifest that the check cannot read turns it off.
 */
function checkPackageVersions(packages: readonly string[]): void {
  const unchecked = [...new Set(packages)].filter(name => !checkedPackageVersions.has(name))
  if (!unchecked.length) return
  if (viteHubManifest === undefined) {
    try {
      viteHubManifest = readViteHubManifest()
    }
    catch {
      viteHubManifest = null
    }
  }
  const error = unsupportedViteHubPackagesError(unchecked, installedPackageVersion, viteHubManifest)
  if (error) {
    // Vite and Nitro print the message of a build error, not its fix. The fix names the install command and pnpm `overrides`.
    console.error(formatDiagnostic(error))
    throw error
  }
  for (const name of unchecked) checkedPackageVersions.add(name)
  const warning = unsupportedPackageVersionsWarning(unchecked, installedPackageVersion, viteHubManifest)
  if (warning) console.warn(warning)
}

/** Returns the loaded owner module, or throws the install error of `feature`. */
export function requireOptionalOwner<T>(module: T | undefined, feature: OptionalFeature): T {
  if (module === undefined) throw missingFeaturePackagesError([feature])
  return module
}
