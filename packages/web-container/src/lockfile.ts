// Lockfile helpers of `createNodeModulesSnapshot`. Internal: no package entry exports them.

/** Dependencies named like this install a wasm build. They are aliases, so the lockfile pins them with the rest. */
export const aliasPrefix = "vitehub-wasm-"

export function aliasName(target: string, version: string): string {
  return `${aliasPrefix}${target.replace(/^@/, "").replace("/", "-")}-${version}`
}

export function withoutAliases(dependencies: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(dependencies).filter(([name]) => !name.startsWith(aliasPrefix)))
}

/** The aliases that the root of a lockfile depends on. */
export function lockedAliases(lockfile: string): Record<string, string> {
  const lock: unknown = JSON.parse(lockfile)
  const root = lock && typeof lock === "object" && "packages" in lock && lock.packages && typeof lock.packages === "object" && "" in lock.packages ? lock.packages[""] : undefined
  const dependencies = root && typeof root === "object" && "dependencies" in root && root.dependencies && typeof root.dependencies === "object" ? root.dependencies : {}
  return Object.fromEntries(Object.entries(dependencies).filter((entry): entry is [string, string] => entry[0].startsWith(aliasPrefix) && typeof entry[1] === "string"))
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
