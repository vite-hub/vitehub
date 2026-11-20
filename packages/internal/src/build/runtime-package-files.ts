import { globSync, readdirSync, readFileSync } from "node:fs"
import { copyFile, mkdir, readdir, stat } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"

import type { Stats } from "node:fs"

const alwaysPublishedFile = /^(?:package\.json|readme(?:\..*)?|licen[cs]e(?:\..*)?)$/i
const globPattern = /[*?[\]{}]/

function hasNodeModulesSegment(path: string): boolean {
  return path.split(/[\\/]/).includes("node_modules")
}

function isNestedPath(path: string): boolean {
  return Boolean(path) && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** Runs a filesystem read, and returns `undefined` when the path is gone. */
async function unlessGone<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  }
  catch (error) {
    // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/**
 * The paths, relative to the package folder, that `npm publish` ships for a package with a `files` list: the list,
 * the `main` and `bin` files, `package.json`, and the README and license files. `undefined` means the whole folder.
 */
export function publishedPackagePaths(packageDir: string): string[] | undefined {
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"))
  }
  catch {
    return undefined
  }
  if (!manifest || typeof manifest !== "object" || !("files" in manifest) || !Array.isArray(manifest.files)) return undefined
  const paths = new Set<string>()
  for (const entry of manifest.files) {
    // An exclusion (`!pattern`) only narrows the list. Copying a little more is safe, so it is ignored.
    if (typeof entry !== "string" || entry.startsWith("!")) continue
    const pattern = entry.replace(/^\.?\//, "").replace(/\/$/, "")
    if (!globPattern.test(pattern)) paths.add(pattern)
    else for (const match of globSync(pattern, { cwd: packageDir })) paths.add(match)
  }
  if ("main" in manifest && typeof manifest.main === "string") paths.add(manifest.main)
  if ("bin" in manifest) {
    const bin = manifest.bin
    if (typeof bin === "string") paths.add(bin)
    else if (bin && typeof bin === "object") for (const file of Object.values(bin)) if (typeof file === "string") paths.add(file)
  }
  for (const entry of readdirSync(packageDir)) if (alwaysPublishedFile.test(entry)) paths.add(entry)
  return [...paths]
    .map(path => relative(packageDir, join(packageDir, path)))
    .filter(path => isNestedPath(path) && !hasNodeModulesSegment(path))
}

/** Tells whether `path`, inside `packageDir`, is a published path, inside one, or a folder that holds one. */
export function isPublishedPackagePath(packageDir: string, publishedPaths: readonly string[] | undefined, path: string): boolean {
  if (!publishedPaths) return true
  const nested = relative(packageDir, path)
  if (!nested) return true
  return publishedPaths.some(published => nested === published
    || nested.startsWith(`${published}${sep}`)
    || published.startsWith(`${nested}${sep}`))
}

/** Copies a file or folder and follows links. `node_modules` folders and paths that disappear during the copy are skipped. */
async function copyTree(source: string, target: string): Promise<void> {
  const info: Stats | undefined = await unlessGone(() => stat(source))
  if (!info) return
  if (!info.isDirectory()) {
    await unlessGone(() => copyFile(source, target))
    return
  }
  const entries = await unlessGone(() => readdir(source))
  if (!entries) return
  await mkdir(target, { recursive: true })
  for (const entry of entries) {
    if (entry !== "node_modules") await copyTree(join(source, entry), join(target, entry))
  }
}

/**
 * Copies one runtime package into deployment output, without its `node_modules`.
 *
 * An installed package only holds its published files. A linked workspace package, such as a `link:` or `workspace:`
 * dependency, is a whole source folder with tests and fixtures, so only the files that `npm publish` would ship are
 * copied. A path that disappears during the copy, such as a temporary test folder that another process removes, is
 * skipped instead of failing the build.
 */
export async function copyRuntimePackageFiles(packageDir: string, targetDir: string): Promise<void> {
  const paths = hasNodeModulesSegment(packageDir) ? undefined : publishedPackagePaths(packageDir)
  if (!paths) {
    await copyTree(packageDir, targetDir)
    return
  }
  await mkdir(targetDir, { recursive: true })
  for (const path of paths) {
    await mkdir(join(targetDir, path, ".."), { recursive: true })
    await copyTree(join(packageDir, path), join(targetDir, path))
  }
}
