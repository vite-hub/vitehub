import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export async function syncPackedWorkspaceDependencies(
  consumerRoot: string,
  workspaceRoot: string,
  packageNames: readonly string[],
): Promise<void> {
  const consumerManifestPath = join(consumerRoot, "package.json")
  const consumerManifest = JSON.parse(await readFile(consumerManifestPath, "utf8"))

  for (const packageName of packageNames) {
    if (!(packageName in consumerManifest.dependencies)) continue
    const name = packageName.replace(/^@vite-hub\//, "")
    const packageManifestPath = join(workspaceRoot, "packages", name, "package.json")
    const version = JSON.parse(await readFile(packageManifestPath, "utf8")).version
    consumerManifest.dependencies[packageName] = `file:./vite-hub-${name}-${version}.tgz`
  }

  await writeFile(consumerManifestPath, `${JSON.stringify(consumerManifest, null, 2)}\n`)
}
