import { lstatSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { array, literal, object, parse, string } from "valibot"

const releaseManifestSchema = object({
  packages: array(object({
    name: string(),
    tarball: string(),
    version: string(),
  })),
  schemaVersion: literal(1),
})

function parseReleaseManifest(source: string, manifestPath: string) {
  try {
    const value: unknown = JSON.parse(source)
    return parse(releaseManifestSchema, value)
  }
  catch (error) {
    throw new Error(`Invalid release manifest: ${manifestPath}`, { cause: error })
  }
}

export function readReleaseArtifactTarballs(repoRoot: string) {
  const configured = process.env.VITEHUB_RELEASE_MANIFEST
  if (!configured) return
  const manifestPath = isAbsolute(configured) ? configured : resolve(repoRoot, configured)
  const manifest = parseReleaseManifest(readFileSync(manifestPath, "utf8"), manifestPath)

  const tarballs = new Map<string, string>()
  for (const pkg of manifest.packages) {
    if (tarballs.has(pkg.name)) throw new Error(`Duplicate release package: ${pkg.name}`)
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
