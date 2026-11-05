import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { boolean, object, optional, parse, record, string } from "valibot"

const packedManifestSchema = object({
  private: optional(boolean()),
  dependencies: optional(record(string(), string())),
  optionalDependencies: optional(record(string(), string())),
  peerDependencies: optional(record(string(), string())),
  peerDependenciesMeta: optional(record(string(), object({ optional: optional(boolean()) }))),
})

// Follow installed dependencies so an unpublished version never falls back to npm.
// Optional peers stay absent unless the consumer explicitly selects them.
export async function packedWorkspacePackages(workspaceRoot: string, names: readonly string[]): Promise<string[]> {
  const packages = new Set(names)
  for (const name of packages) {
    const manifest = parse(packedManifestSchema, JSON.parse(await readFile(join(workspaceRoot, "packages", name, "package.json"), "utf8")))
    if (manifest.private) throw new Error(`Cannot pack private workspace package ${name}`)
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...Object.fromEntries(Object.entries(manifest.peerDependencies ?? {})
        .filter(([peer]) => !manifest.peerDependenciesMeta?.[peer]?.optional)),
    }
    for (const dependency of Object.keys(dependencies)) {
      if (dependency.startsWith("@vite-hub/")) packages.add(dependency.slice("@vite-hub/".length))
      else if (dependency === "vite-hub") packages.add(dependency)
    }
  }
  return [...packages]
}

export async function syncPackedWorkspaceDependencies(
  consumerRoot: string,
  workspaceRoot: string,
  packageNames: readonly string[],
): Promise<void> {
  const consumerManifestPath = join(consumerRoot, "package.json")
  const consumerManifest = JSON.parse(await readFile(consumerManifestPath, "utf8"))
  // Temporary consumers must not inherit the machine's default package manager.
  consumerManifest.packageManager ??= JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8")).packageManager
  const overrides: string[] = []

  for (const packageName of packageNames) {
    const name = packageName.replace(/^@vite-hub\//, "")
    const packageManifestPath = join(workspaceRoot, "packages", name, "package.json")
    const version = JSON.parse(await readFile(packageManifestPath, "utf8")).version
    const dependency = `file:./vite-hub-${name}-${version}.tgz`
    overrides.push(`  "${packageName}": "${dependency}"`)
    if (packageName in consumerManifest.dependencies) consumerManifest.dependencies[packageName] = dependency
  }

  await writeFile(consumerManifestPath, `${JSON.stringify(consumerManifest, null, 2)}\n`)

  const workspaceManifestPath = join(consumerRoot, "pnpm-workspace.yaml")
  try {
    await readFile(workspaceManifestPath)
    await writeFile(workspaceManifestPath, `overrides:\n${overrides.join("\n")}\n`)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}
