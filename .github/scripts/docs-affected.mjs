// Prints "true" when a pull request can change the docs build, "false" otherwise.
// Usage: node .github/scripts/docs-affected.mjs <base-ref>
// Only a change made entirely inside packages that docs/package.json does not
// depend on skips the docs build. Anything else runs it: docs, root and
// workflow files, tests, and the packages the docs import. Deeper package
// changes still build the docs on the push to main.
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export function docsAffected(files, docsManifest, packageDirs) {
  const dependencies = { ...docsManifest.dependencies, ...docsManifest.devDependencies }
  const docsPackages = new Set(Object.entries(dependencies)
    .filter(([, version]) => String(version).startsWith("workspace:"))
    .map(([name]) => name))
  return files.some((file) => {
    const dir = /^packages\/([^/]+)\//.exec(file)?.[1]
    if (dir === undefined) return true
    const name = packageDirs.get(dir)
    return name === undefined || docsPackages.has(name)
  })
}

function readPackageDirs(root) {
  const dirs = new Map()
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      dirs.set(entry.name, JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8")).name)
    }
    catch {}
  }
  return dirs
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const base = process.argv[2]
  if (!base) throw new Error("Usage: docs-affected.mjs <base-ref>")
  const files = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`], { encoding: "utf8" })
    .split("\0").filter(Boolean)
  const docsManifest = JSON.parse(readFileSync("docs/package.json", "utf8"))
  console.log(String(docsAffected(files, docsManifest, readPackageDirs(process.cwd()))))
}
