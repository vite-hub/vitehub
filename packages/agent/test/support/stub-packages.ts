import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** Installs empty packages under `root/node_modules` so that generated imports of `specifiers` resolve. */
export async function installStubPackages(root: string, specifiers: string[]): Promise<void> {
  const packages = new Map<string, Record<string, string>>()
  for (const specifier of specifiers) {
    const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")
    packages.set(name, { ...packages.get(name), [`.${specifier.slice(name.length)}`]: "./index.js" })
  }
  for (const [name, exports] of packages) {
    await mkdir(join(root, "node_modules", name), { recursive: true })
    await writeFile(join(root, "node_modules", name, "package.json"), JSON.stringify({ exports, name }), "utf8")
    await writeFile(join(root, "node_modules", name, "index.js"), "", "utf8")
  }
}
