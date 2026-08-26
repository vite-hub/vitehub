import { lstatSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

interface ReleasePackage {
  name: string
  tarball: string
  version: string
}

interface ReleaseManifest {
  packages: ReleasePackage[]
  schemaVersion: number
}

export function readReleaseArtifactTarballs(repoRoot: string) {
  const configured = process.env.VITEHUB_RELEASE_MANIFEST
  if (!configured) return
  const manifestPath = isAbsolute(configured) ? configured : resolve(repoRoot, configured)
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages)) {
    throw new Error(`Invalid release manifest: ${manifestPath}`)
  }

  const tarballs = new Map<string, string>()
  for (const pkg of manifest.packages) {
    if (tarballs.has(pkg.name)) throw new Error(`Duplicate release package: ${pkg.name}`)
    if (typeof pkg.tarball !== "string" || typeof pkg.version !== "string") throw new Error(`Invalid release package: ${pkg.name}`)
    const path = join(dirname(manifestPath), pkg.tarball)
    const stats = lstatSync(path)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Release tarball is not a regular file: ${path}`)
    tarballs.set(pkg.name, path)
  }
  return tarballs
}

export function resolveReleaseArtifactTarball<T>(
  releaseTarballs: Map<string, string> | undefined,
  packageName: string,
  pack: () => T,
): string | T {
  if (!releaseTarballs) return pack()
  const tarball = releaseTarballs.get(packageName)
  if (!tarball) throw new Error(`Missing release tarball for ${packageName}`)
  return tarball
}
