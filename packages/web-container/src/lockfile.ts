/** Dependencies named like this install a wasm build. They are aliases, so the lockfile pins them with the rest. */
export const aliasPrefix = "vitehub-wasm-"

export function aliasName(target: string, version: string): string {
  return `${aliasPrefix}${target.replace(/^@/, "").replace("/", "-")}-${version}`
}

export function withoutAliases(dependencies: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(dependencies).filter(([name]) => !name.startsWith(aliasPrefix)))
}

/** The aliases that the root of a lockfile depends on: optional dependencies, or regular ones in an older lockfile. */
export function lockedAliases(lockfile: string): Record<string, string> {
  const lock: unknown = JSON.parse(lockfile)
  const root = isObject(lock) && isObject(lock.packages) && isObject(lock.packages[""]) ? lock.packages[""] : {}
  const entries = [root.dependencies, root.optionalDependencies].flatMap(field => isObject(field) ? Object.entries(field) : [])
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => entry[0].startsWith(aliasPrefix) && typeof entry[1] === "string"))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

export function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key])
}

/**
 * The tarballs of `file:` dependencies, such as packed workspace packages, change with each build. Their integrity in
 * the lockfile would fail `npm ci` after a rebuild, so leave it out; registry packages keep theirs.
 */
export function withoutTarballIntegrity(lockfile: string): string {
  const lock: { packages?: Record<string, { resolved?: string, integrity?: string }> } = JSON.parse(lockfile)
  for (const entry of Object.values(lock.packages ?? {})) {
    if (entry.resolved?.startsWith("file:")) delete entry.integrity
  }
  return `${JSON.stringify(lock, null, 2)}\n`
}

/** The `file:` paths that the lockfile installs, such as `tarballs/vite-hub-forge-0.1.0.tgz`, relative to the app. */
export function lockedFiles(lockfile: string): string[] {
  const lock: unknown = JSON.parse(lockfile)
  const packages = isObject(lock) && isObject(lock.packages) ? Object.values(lock.packages) : []
  return packages.flatMap(entry => isObject(entry) && typeof entry.resolved === "string" && entry.resolved.startsWith("file:") ? [entry.resolved.slice("file:".length)] : [])
}

/**
 * The lockfile without its `file:` packages. npm keeps the dependencies that a lockfile records for a tarball, so an
 * update would still install a package that a packed workspace package no longer depends on. Without the entries, npm
 * reads each tarball again and keeps the registry versions.
 */
export function withoutFilePackages(lockfile: string): string {
  const lock: { packages?: Record<string, { resolved?: string }> } = JSON.parse(lockfile)
  const packages = lock.packages ?? {}
  for (const [path, entry] of Object.entries(packages)) {
    if (entry.resolved?.startsWith("file:")) delete packages[path]
  }
  return `${JSON.stringify(lock, null, 2)}\n`
}
