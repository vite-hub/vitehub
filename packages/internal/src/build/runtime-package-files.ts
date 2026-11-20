import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { chmod, copyFile, cp, lstat, mkdir, readdir, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"

import { Minimatch } from "minimatch"

import type { Stats } from "node:fs"

const alwaysPublishedFile = /^(?:package\.json|(?:readme|copying|licen[cs]e)(?:\..*[^~$])?)$/i
const rootExcluded = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", ".lock-wscript", "build/config.gypi"])
const excludedEntry = /^(?:node_modules|\.git|\.hg|\.svn|CVS|\.npmrc|\.npmignore|\.gitignore|\.DS_Store|npm-debug\.log|\._.*|.*\.orig|\..*\.swp)$/i

function hasNodeModulesSegment(path: string): boolean {
  return path.split(/[\\/]/).includes("node_modules")
}

function isNestedPath(path: string): boolean {
  return Boolean(path) && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** Runs a filesystem read, and returns `undefined` when the path is gone. */
export async function unlessGone<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  }
  catch (error) {
    // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
    const { code } = error as NodeJS.ErrnoException
    if (code === "ENOENT" || code === "ENOTDIR") return undefined
    throw error
  }
}

function readIfPresent<T>(read: () => T): T | undefined {
  try {
    return read()
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function packageRule(entry: string) {
  const include = !entry.startsWith("!")
  const pattern = (include ? entry : entry.slice(1)).replace(/^\.\//, "/").replace(/\/$/, "") || "**"
  const matcher = new Minimatch(pattern, { dot: true, matchBase: true, nocase: true, nocomment: true, nonegate: true })
  return {
    include,
    matches: (path: string, partial = false): boolean => matcher.match(path, partial) || matcher.match(`/${path}`, partial),
  }
}

interface PublishedPackagePaths {
  files: Set<string>
  entries: Set<string>
}

/** Files selected for a linked package's publish list; `undefined` keeps the whole package. */
export function publishedPackagePaths(packageDir: string): PublishedPackagePaths | undefined {
  let manifest: unknown
  const contents = readIfPresent(() => readFileSync(join(packageDir, "package.json"), "utf8"))
  if (contents === undefined) return undefined
  try {
    manifest = JSON.parse(contents)
  }
  catch {
    return undefined
  }
  if (!manifest || typeof manifest !== "object" || !("files" in manifest) || !Array.isArray(manifest.files)) return undefined
  const rules: ReturnType<typeof packageRule>[] = []
  const required = new Set<string>()
  const requiredAncestors = new Set<string>()
  const requirePath = (entry: string): void => {
    const path = relative(packageDir, join(packageDir, entry))
    if (!isNestedPath(path)) return
    required.add(path)
    for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) requiredAncestors.add(parent)
  }
  for (const entry of manifest.files) {
    if (typeof entry !== "string" || !entry) continue
    const candidate = join(packageDir, entry)
    if (!entry.startsWith("!") && isNestedPath(relative(packageDir, candidate)) && readIfPresent(() => lstatSync(candidate))?.isFile()) requirePath(entry)
    else rules.push(packageRule(entry.endsWith("/*") ? `${entry}*` : entry))
  }
  if ("main" in manifest && typeof manifest.main === "string") requirePath(manifest.main)
  if ("browser" in manifest && typeof manifest.browser === "string") requirePath(manifest.browser)
  if ("bin" in manifest) {
    const bin = manifest.bin
    if (typeof bin === "string") requirePath(bin)
    else if (bin && typeof bin === "object") for (const file of Object.values(bin)) if (typeof file === "string") requirePath(file)
  }
  const files = new Set<string>()
  const entries = new Set<string>([""])
  const visit = (directory: string, ancestors: string[], inheritedIgnores: ((paths: string[], included: boolean) => boolean)[]): void => {
    const children = readIfPresent(() => readdirSync(join(packageDir, directory)))
    if (!children) return
    let ignores = inheritedIgnores
    if (directory) {
      const ignore = readIfPresent(() => readFileSync(join(packageDir, directory, ".npmignore"), "utf8"))
        ?? readIfPresent(() => readFileSync(join(packageDir, directory, ".gitignore"), "utf8"))
      if (ignore) {
        const localRules = ignore.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#")).map(packageRule)
        ignores = [...ignores, (paths, included) => {
          for (const rule of localRules) {
            if (paths.slice(ancestors.length).some(path => rule.matches(path.slice(directory.length + 1)))) included = !rule.include
          }
          return included
        }]
      }
    }
    for (const child of children) {
      const path = join(directory, child)
      const portablePath = path.replaceAll(sep, "/")
      if (excludedEntry.test(child) || rootExcluded.has(portablePath) || child.includes("*")) continue
      const prefixes = [...ancestors, portablePath]
      let included = false
      for (const rule of rules) if (prefixes.some(prefix => rule.matches(prefix))) included = rule.include
      const includeFile = (included && ignores.every(ignore => ignore(prefixes, true))) || required.has(path) || (!directory && alwaysPublishedFile.test(child))
      const includeDirectory = included || requiredAncestors.has(path) || rules.some(rule => rule.include && rule.matches(portablePath, true))
      if (!includeFile && !includeDirectory) continue
      const info = readIfPresent(() => lstatSync(join(packageDir, path)))
      if (info?.isDirectory() && includeDirectory) {
        visit(path, prefixes, ignores)
      }
      else if (info?.isFile() && includeFile) {
        files.add(path)
        for (let entry = path; entry !== "." && !entries.has(entry); entry = dirname(entry)) entries.add(entry)
      }
    }
  }
  visit("", [], [])
  return { files, entries }
}

/** A published file or a directory that contains one. */
export function isPublishedPackagePath(packageDir: string, publishedPaths: PublishedPackagePaths | undefined, path: string): boolean {
  return !publishedPaths || publishedPaths.entries.has(relative(packageDir, path))
}

/** Copies a filtered source tree, preserving symlinks, while tolerating disappearance entry by entry. */
export async function copyRetainedSourceTree(source: string, target: string, filter: (path: string) => boolean): Promise<void> {
  async function copyEntry(source: string, target: string, freshParent: boolean): Promise<void> {
    if (!filter(source)) return
    const info = await unlessGone(() => lstat(source))
    if (!info) return
    if (info.isFile() && freshParent) {
      await unlessGone(() => copyFile(source, target))
      return
    }
    if (!info.isDirectory()) {
      await unlessGone(() => cp(source, target))
      return
    }
    const entries = await unlessGone(() => readdir(source))
    if (!entries) return
    const created = await mkdir(target, { recursive: true })
    for (const entry of entries) await copyEntry(join(source, entry), join(target, entry), created !== undefined)
    if (created) await chmod(target, info.mode)
  }
  await copyEntry(source, target, false)
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
  for (const path of paths.files) {
    const target = join(targetDir, path)
    await mkdir(dirname(target), { recursive: true })
    await unlessGone(() => copyFile(join(packageDir, path), target))
  }
}
