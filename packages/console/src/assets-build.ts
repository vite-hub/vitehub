import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { z } from "zod"

import { consoleErrorDiagnostics } from "./error-diagnostics.ts"

import type { ConsoleAssets } from "./assets.ts"

/** The page tools pill parts in the `vite-hub` package, by the name that the Console serves them under. */
export const consolePageAssetFiles = { "account.js": "dist/console/runtime/page-tool/account.js", "page-tool.js": "dist/console/runtime/page-tool/page-tool.js" }

/** The folder of the skills that an app serves at `<base>/_vitehub/.well-known/skills`, in the `vite-hub` package. */
export const consoleSkillsFolder = "dist/console/runtime/public/skills"

/** The folder of the hosted Comments embed in the `@vite-hub/comments` package. */
export const hostedCommentsFolder = "dist/hosted"

/** The folder of the installed `vite-hub` package. */
export function viteHubPackageRoot(): string {
  return dirname(fileURLToPath(import.meta.resolve("vite-hub/package.json")))
}

/**
 * Read the files that the Console serves from the built `vite-hub` package: the same skills that apps serve, and the
 * page tools pill parts. It runs at Console build time. A missing file names the build that makes it.
 */
export function readConsoleAssets(): ConsoleAssets {
  const root = viteHubPackageRoot()
  const read = (path: string) => {
    const file = join(root, path)
    if (!existsSync(file)) throw consoleErrorDiagnostics.CONSOLE_VITE_HUB_BUILD_MISSING({ file })
    return readFileSync(file, "utf8")
  }
  const skillsRoot = join(root, consoleSkillsFolder)
  read(join(consoleSkillsFolder, "index.json"))
  const skills = Object.fromEntries(readdirSync(skillsRoot, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(skillsRoot, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort()
    .map(path => [path, readFileSync(join(skillsRoot, path), "utf8")]))
  const page = Object.fromEntries(Object.entries(consolePageAssetFiles).map(([name, path]) => {
    const source = read(path)
    return [name, { hash: createHash("sha256").update(source).digest("hex").slice(0, 16), source }]
  }))
  const { version } = z.object({ version: z.string().min(1) }).parse(JSON.parse(read("package.json")))
  return { page, skills, hostedComments: readHostedComments(), version }
}

/** The folder of the `@vite-hub/comments` package that the installed `vite-hub` package uses. */
export function commentsPackageRoot(): string {
  return dirname(createRequire(join(viteHubPackageRoot(), "package.json")).resolve("@vite-hub/comments/package.json"))
}

function readHostedComments(): Record<string, string> {
  const folder = join(commentsPackageRoot(), hostedCommentsFolder)
  const entry = join(folder, "hosted-comments.js")
  if (!existsSync(entry)) throw consoleErrorDiagnostics.CONSOLE_VITE_HUB_BUILD_MISSING({ file: entry })
  return Object.fromEntries(readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".js"))
    .map(entry => relative(folder, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort()
    .map(path => [path, readFileSync(join(folder, path), "utf8")]))
}
