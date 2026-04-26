import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  packageDir,
  packageNames,
  readJson,
  readPackageManifest,
  repoRoot,
  toRepoPath,
  walkFiles,
  type PackageName,
} from "./utils/repo"

const ignoredGeneratedDirs = new Set([
  ".nuxt",
  ".output",
  ".vercel",
  ".wrangler",
  "dist",
  "node_modules",
])

function exportTargetPath(packageName: PackageName, target: string) {
  return join(packageDir(packageName), target.replace(/^\.\//, ""))
}

function hasExport(packageName: string, specifier: string) {
  const shortName = packageName.replace("@vitehub/", "") as PackageName
  const manifest = readPackageManifest(shortName)
  const subpath = specifier.slice(packageName.length)

  if (!subpath) {
    return true
  }

  return Boolean(manifest.exports?.[`.${subpath}`])
}

function hasGeneratedOutputUnderExampleSurface(path: string) {
  const parts = path.split("/")
  const surfaceIndex = parts.findIndex(part => part === "examples" || part === "playground")
  return surfaceIndex !== -1 && parts.slice(surfaceIndex + 1).some(part => ignoredGeneratedDirs.has(part))
}

describe("package manifest contracts", () => {
  it("keeps landed package manifests publishable by convention", () => {
    for (const packageName of packageNames) {
      const manifest = readPackageManifest(packageName)

      expect(manifest.name).toBe(`@vitehub/${packageName}`)
      expect(manifest.description, `${packageName} should describe its package`).toEqual(expect.any(String))
      expect(manifest.license).toBe("Apache-2.0")
      expect(manifest.sideEffects).toBe(false)
      expect(manifest.type).toBe("module")
      expect(manifest.types).toBe("./dist/index.d.ts")
      expect(manifest.files).toEqual(expect.arrayContaining(["dist", "package.json"]))
      expect(manifest.scripts?.build).toEqual(expect.any(String))
      expect(manifest.scripts?.typecheck).toEqual(expect.any(String))
      expect(manifest.scripts?.test).toEqual(expect.any(String))
      expect(manifest.exports?.["."]).toBe("./dist/index.js")
      expect(manifest.exports?.["./package.json"]).toBe("./package.json")
    }
  })

  it("keeps export targets under dist except package.json", () => {
    for (const packageName of packageNames) {
      const manifest = readPackageManifest(packageName)

      for (const [subpath, rawTarget] of Object.entries(manifest.exports || {})) {
        const target = typeof rawTarget === "string" ? rawTarget : rawTarget.default
        expect(target, `${packageName} ${subpath} should use string/default export target`).toEqual(expect.any(String))

        if (subpath === "./package.json") {
          expect(target).toBe("./package.json")
          expect(existsSync(exportTargetPath(packageName, target))).toBe(true)
          continue
        }

        expect(target, `${packageName} ${subpath} should point to dist`).toMatch(/^\.\/dist\/.+\.js$/)
      }
    }
  })
})

describe("docs import contracts", () => {
  it("only references existing @vitehub package exports in source docs", () => {
    const markdownFiles = [
      ...walkFiles(join(repoRoot, "docs", "content"), { extensions: new Set(["md"]) }),
      ...packageNames.flatMap(packageName => walkFiles(join(packageDir(packageName), "docs"), { extensions: new Set(["md"]) })),
    ]
    const specifiers = new Set<string>()
    const importPattern = /from\s+['"](@vitehub\/[^'"]+)['"]|import\s+['"](@vitehub\/[^'"]+)['"]/g

    for (const file of markdownFiles) {
      const source = readFileSync(file, "utf8")
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] || match[2]
        if (specifier) {
          specifiers.add(specifier)
        }
      }
    }

    expect(specifiers.size).toBeGreaterThan(0)

    for (const specifier of specifiers) {
      const [scope, name] = specifier.split("/")
      const packageName = `${scope}/${name}`
      expect(packageNames.map(item => `@vitehub/${item}`), `Unexpected docs package import: ${specifier}`).toContain(packageName)
      expect(hasExport(packageName, specifier), `Missing docs export: ${specifier}`).toBe(true)
    }
  })
})

describe("showcase contracts", () => {
  it("keeps existing showcase manifests pointed at real files", () => {
    for (const packageName of packageNames) {
      const manifestPath = join(packageDir(packageName), "examples", "showcase.json")
      if (!existsSync(manifestPath)) {
        continue
      }

      const manifest = readJson<{
        label?: string
        frameworks?: Record<string, { modes?: Record<string, { phases?: Record<string, string>, supplementalFiles?: string[] }> }>
      }>(manifestPath)

      expect(manifest.label, `${packageName} showcase should have a label`).toEqual(expect.any(String))
      expect(manifest.frameworks, `${packageName} showcase should list frameworks`).toEqual(expect.any(Object))

      for (const [framework, frameworkConfig] of Object.entries(manifest.frameworks || {})) {
        for (const [mode, modeConfig] of Object.entries(frameworkConfig.modes || {})) {
          const files = [
            ...Object.values(modeConfig.phases || {}),
            ...(modeConfig.supplementalFiles || []),
          ]

          for (const file of files) {
            const path = join(packageDir(packageName), "examples", framework, file)
            expect(existsSync(path), `${packageName}/${framework}/${mode} references missing file: ${file}`).toBe(true)
          }
        }
      }
    }
  })
})

describe("runtime hygiene contracts", () => {
  it("does not track generated output under package examples or playgrounds", () => {
    const tracked = execFileSync("git", ["ls-files", "packages"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .filter(hasGeneratedOutputUnderExampleSurface)

    expect(tracked).toEqual([])
  })

  it("does not use stale generated globals in runtime source", () => {
    const runtimeFiles = packageNames.flatMap(packageName =>
      walkFiles(packageDir(packageName), {
        ignoreDirs: ignoredGeneratedDirs,
        extensions: new Set(["ts"]),
      }).filter(path => toRepoPath(path).includes("/src/runtime/")),
    )

    const offenders = runtimeFiles
      .filter(path => !toRepoPath(path).endsWith("/empty-registry.ts"))
      .filter(path => readFileSync(path, "utf8").includes("__vitehub"))
      .map(toRepoPath)

    expect(offenders).toEqual([])
  })
})
