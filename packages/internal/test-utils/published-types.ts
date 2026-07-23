import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export async function syncPackedWorkspaceDependencies(
  consumerRoot: string,
  workspaceRoot: string,
  packageNames: readonly string[],
): Promise<void> {
  const consumerManifestPath = join(consumerRoot, "package.json")
  const consumerManifest = JSON.parse(await readFile(consumerManifestPath, "utf8"))
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
