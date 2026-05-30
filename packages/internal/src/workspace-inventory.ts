import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

export interface WorkspacePackageInfo {
  dir: string
  name: string
  packageName: string
  private: boolean
}

interface PackageManifest {
  name?: string
  private?: boolean
}

function readPackageManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest
}

function isViteHubPackageName(name: string | undefined): boolean {
  return name === "vite-hub" || Boolean(name?.startsWith("@vite-hub/"))
}

export function listWorkspacePackageInfos(workspaceRoot: string): WorkspacePackageInfo[] {
  const packagesDir = resolve(workspaceRoot, "packages")
  if (!existsSync(packagesDir)) {
    return []
  }

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map((entry) => {
      const dir = join(packagesDir, entry.name)
      const manifestPath = join(dir, "package.json")
      if (!existsSync(manifestPath)) {
        return undefined
      }

      const manifest = readPackageManifest(manifestPath)
      if (!isViteHubPackageName(manifest.name)) {
        return undefined
      }

      return {
        dir,
        name: entry.name,
        packageName: manifest.name,
        private: Boolean(manifest.private),
      } satisfies WorkspacePackageInfo
    })
    .filter((entry): entry is WorkspacePackageInfo => Boolean(entry))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function listWorkspacePackageNames(workspaceRoot: string, options: { includePrivate?: boolean } = {}): string[] {
  return listWorkspacePackageInfos(workspaceRoot)
    .filter(entry => options.includePrivate ? true : !entry.private)
    .map(entry => entry.name)
}
