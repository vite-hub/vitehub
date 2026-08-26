import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { array, object, optional, record, string } from "valibot"
import { describe, expect, it } from "vitest"
import {
  packageDir,
  packageInfo,
  packageInfoByPublishName,
  packageInfos,
  packageManifestSchema,
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

const showcaseManifestSchema = object({
  label: optional(string()),
  frameworks: optional(record(string(), object({
    modes: optional(record(string(), object({
      phases: optional(record(string(), string())),
      supplementalFiles: optional(array(string())),
    }))),
  }))),
})

function exportTargetPath(packageName: PackageName, target: string) {
  return join(packageDir(packageName), target.replace(/^\.\//, ""))
}

function exportTarget(rawTarget: unknown) {
  if (typeof rawTarget === "string") return rawTarget
  if (rawTarget && typeof rawTarget === "object") {
    const target = rawTarget as { default?: unknown, import?: unknown }
    if (typeof target.default === "string") return target.default
    if (typeof target.import === "string") return target.import
  }
}

function hasExport(packageName: string, specifier: string) {
  const manifest = readPackageManifest(packageInfoByPublishName(packageName).name)
  const subpath = specifier.slice(packageName.length)

  if (!subpath) {
    return true
  }

  return Boolean(manifest.exports?.[`.${subpath}`])
}

function publishNameFromSpecifier(specifier: string) {
  if (specifier === "vite-hub" || specifier.startsWith("vite-hub/")) return "vite-hub"
  const match = /^(@vite-hub\/[^/]+)/.exec(specifier)
  return match?.[1]
}

function hasGeneratedOutputUnderExampleSurface(path: string) {
  const parts = path.split("/")
  const surfaceIndex = parts.findIndex(part => part === "examples" || part === "playground")
  return surfaceIndex !== -1 && parts.slice(surfaceIndex + 1).some(part => ignoredGeneratedDirs.has(part))
}

describe("package manifest contracts", () => {
  it("tracks every publishable workspace package in the contract surface", () => {
    expect(packageNames).toEqual(expect.arrayContaining(["blob", "database", "kv", "queue", "sandbox", "vite-hub", "workflow"]))
  })

  it("keeps landed package manifests publishable by convention", () => {
    for (const packageName of packageNames) {
      const manifest = readPackageManifest(packageName)

      expect(manifest.name).toBe(packageInfo(packageName).packageName)
      expect(manifest.description, `${packageName} should describe its package`).toEqual(expect.any(String))
      expect(manifest.license).toBe("Apache-2.0")
      if (manifest.sideEffects !== false) {
        expect(manifest.sideEffects, `${packageName} side effects should name published artifacts`)
          .toEqual(expect.arrayContaining([expect.any(String)]))

        const publishedArtifacts = new Set([
          ...Object.values(manifest.bin || {}),
          ...Object.values(manifest.exports || {})
            .map(exportTarget)
            .filter((target): target is string => Boolean(target)),
        ])
        for (const sideEffect of manifest.sideEffects as string[]) {
          expect(publishedArtifacts, `${packageName} side effect ${sideEffect} should be exported or executable`)
            .toContain(sideEffect)
        }
      }
      expect(manifest.type).toBe("module")
      expect(manifest.types).toBe("./dist/index.d.ts")
      expect(manifest.files).toEqual(expect.arrayContaining(["dist", "package.json"]))
      expect(manifest.scripts?.build).toEqual(expect.any(String))
      expect(manifest.scripts?.typecheck).toEqual(expect.any(String))
      expect(manifest.scripts?.test).toEqual(expect.any(String))
      expect(exportTarget(manifest.exports?.["."])).toBe("./dist/index.js")
      expect(manifest.exports?.["./package.json"]).toBe("./package.json")
    }
  })

  it("uses the repository Apache license and source metadata for every public package", () => {
    const rootManifest = readJson(packageManifestSchema, join(repoRoot, "package.json"))
    const expectedRepository = {
      type: "git",
      url: "git+https://github.com/vite-hub/vitehub.git",
    }

    expect(rootManifest).toMatchObject({
      license: "Apache-2.0",
      repository: expectedRepository,
    })
    expect(readFileSync(join(repoRoot, "LICENSE"), "utf8")).toContain("Apache License\n                           Version 2.0, January 2004")

    for (const info of packageInfos) {
      const manifest = readPackageManifest(info.name)
      expect(manifest.license, `${info.packageName} should use the repository license`).toBe("Apache-2.0")
      expect(manifest.repository, `${info.packageName} should identify its monorepo source`).toEqual({
        ...expectedRepository,
        directory: `packages/${info.name}`,
      })
    }
  })

  it("includes the repository license in every packed public package", () => {
    const packDir = mkdtempSync(join(tmpdir(), "vitehub-license-pack-"))
    const license = readFileSync(join(repoRoot, "LICENSE"), "utf8")

    try {
      for (const info of packageInfos) {
        const before = new Set(readdirSync(packDir))
        execFileSync("pnpm", ["--filter", info.packageName, "pack", "--pack-destination", packDir], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "pipe",
        })
        const tarballs = readdirSync(packDir).filter(file => !before.has(file))
        expect(tarballs, `${info.packageName} should create one tarball`).toHaveLength(1)

        const tarball = join(packDir, tarballs[0]!)
        const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n")
        expect(listing, `${info.packageName} should include the root license`).toContain("package/LICENSE")
        expect(execFileSync("tar", ["-xOf", tarball, "package/LICENSE"], { encoding: "utf8" }))
          .toBe(license)
      }
    }
    finally {
      rmSync(packDir, { recursive: true })
    }
  }, 30_000)

  it("publishes security reporting and project policy links", () => {
    const security = readFileSync(join(repoRoot, "SECURITY.md"), "utf8")
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8")
    const contact = readFileSync(join(repoRoot, "docs/content/trust/contact.md"), "utf8")

    expect(security).toContain("https://github.com/vite-hub/vitehub/security/advisories")
    expect(security).toContain("https://github.com/vite-hub/vitehub/issues/new")
    expect(security).toContain("https://discord.gg/YTRDsRP3")
    expect(security).toContain("Published 0.x versions | No backports")
    expect(security).not.toMatch(/mailto:|[\w.+-]+@[\w.-]+/)
    expect(readme).toContain("[Apache License 2.0](LICENSE)")
    expect(readme).toContain("[security policy](SECURITY.md)")
    expect(contact).toContain("https://github.com/vite-hub/vitehub/security/policy")
    expect(contact).not.toContain("/security/advisories/new")
  })

  it("publishes required package dependencies before their consumers", () => {
    const order = execFileSync(process.execPath, [join(repoRoot, ".github/scripts/package-release-order.mjs")], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim().split("\n")
    const positions = new Map(order.map((path, index) => [readJson(packageManifestSchema, join(repoRoot, path)).name, index]))

    expect(positions.size).toBe(packageInfos.length)
    for (const info of packageInfos) {
      const manifest = readPackageManifest(info.name)
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }
      for (const dependency of Object.keys(dependencies)) {
        if (!positions.has(dependency)) continue
        expect(positions.get(dependency), `${dependency} must publish before ${info.packageName}`)
          .toBeLessThan(positions.get(info.packageName)!)
      }
    }
  })

  it("keeps code exports under dist and publishes static asset exports explicitly", () => {
    for (const packageName of packageNames) {
      const manifest = readPackageManifest(packageName)

      for (const [subpath, rawTarget] of Object.entries(manifest.exports || {})) {
        const target = exportTarget(rawTarget)
        expect(target, `${packageName} ${subpath} should use string/default export target`).toEqual(expect.any(String))

        if (subpath === "./package.json") {
          expect(target).toBe("./package.json")
          expect(existsSync(exportTargetPath(packageName, target))).toBe(true)
          continue
        }

        if (packageName === "vite-hub" && subpath === "./tsconfig") {
          expect(target).toBe("./tsconfig.json")
          expect(existsSync(exportTargetPath(packageName, target))).toBe(true)
          continue
        }

        if (target.endsWith(".css")) {
          expect(subpath, `${packageName} ${subpath} should expose CSS through a CSS subpath`).toMatch(/\.css$/)
          expect(target, `${packageName} ${subpath} should point to a built CSS asset`).toMatch(/^\.\/dist\/.+\.css$/)
          continue
        }

        expect(target, `${packageName} ${subpath} should point to dist`).toMatch(/^\.\/dist\/.+\.js$/)
      }
    }
  })

  it("keeps the private Vercel Blob runtime owned by the blob package", () => {
    const manifest = readPackageManifest("blob")
    const frameworkManifest = readPackageManifest("vite-hub")
    const kvManifest = readPackageManifest("kv")

    expect(manifest.dependencies?.["files-sdk"]).toBeUndefined()
    expect(manifest.peerDependencies?.["files-sdk"]).toEqual(expect.any(String))
    expect(manifest.peerDependenciesMeta?.["files-sdk"]?.optional).toBe(true)
    expect(manifest.devDependencies?.["files-sdk"]).toEqual(expect.any(String))
    expect(manifest.dependencies?.["@vercel/blob"]).toBeUndefined()
    expect(manifest.devDependencies?.["@vercel/blob"]).toEqual(expect.any(String))
    expect(frameworkManifest.dependencies?.["files-sdk"]).toBeUndefined()
    expect(frameworkManifest.dependencies?.["@vite-hub/netlify-blobs-runtime"]).toMatch(/^npm:@netlify\/blobs@/)
    expect(kvManifest.dependencies?.unstorage).toBeUndefined()
    expect(kvManifest.devDependencies?.unstorage).toEqual(expect.any(String))
  })
})

describe("docs import contracts", () => {
  it("documents every public framework import", () => {
    const manifest = readPackageManifest("vite-hub")
    const reference = readFileSync(join(repoRoot, "docs/content/docs/reference/import-paths.md"), "utf8")
    const documented = new Set([...reference.matchAll(/`(vite-hub(?:\/[^`]+)?)`/g)].map(match => match[1]))

    for (const subpath of Object.keys(manifest.exports || {})) {
      if (subpath === "./package.json" || subpath.startsWith("./_internal/")) continue
      const specifier = subpath === "." ? "vite-hub" : `vite-hub/${subpath.slice(2)}`
      expect(documented, `Missing framework import reference: ${specifier}`).toContain(specifier)
    }
  })

  it("only references existing ViteHub package exports in source docs", () => {
    const markdownFiles = [
      ...walkFiles(join(repoRoot, "docs", "content"), { extensions: new Set(["md"]) }),
      ...packageNames.flatMap(packageName => walkFiles(join(packageDir(packageName), "docs"), { extensions: new Set(["md"]) })),
    ]
    const specifiers = new Set<string>()
    const importPattern = /(?:from\s+|import\s+)['"]((?:@vite-hub\/[^'"]+)|(?:vite-hub(?:\/[^'"]+)?))['"]/g

    for (const file of markdownFiles) {
      const source = readFileSync(file, "utf8")
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1]
        if (specifier) {
          specifiers.add(specifier)
        }
      }
    }

    expect(specifiers.size).toBeGreaterThan(0)
    const publishNames = packageInfos.map(info => info.packageName)

    for (const specifier of specifiers) {
      const packageName = publishNameFromSpecifier(specifier)
      if (!packageName) {
        throw new Error(`Could not identify docs package import: ${specifier}`)
      }
      expect(publishNames, `Unexpected docs package import: ${specifier}`).toContain(packageName)
      expect(hasExport(packageName, specifier), `Missing docs export: ${specifier}`).toBe(true)
    }
  })
})

describe("playground import contracts", () => {
  it("keeps the Vite e2e workspace shim aligned with root source exports", () => {
    const sourceIndex = readFileSync(join(packageDir("workspace"), "src", "sources", "index.ts"), "utf8")
    const viteE2e = readFileSync(join(repoRoot, "playground", "vite", "build", "vite-e2e.ts"), "utf8")
    const workspaceShim = viteE2e.slice(
      viteE2e.indexOf("function renderWorkspaceRuntimeModule"),
      viteE2e.indexOf("function renderWorkspaceShellRuntimeModule"),
    )
    const vercelQueueWrapper = viteE2e.slice(
      viteE2e.indexOf("function renderVercelQueueWrapper"),
      viteE2e.indexOf("function renderVercelScheduleWrapper"),
    )
    const sourceExports = [...sourceIndex.matchAll(/^export \{ (\w+) \}/gm)].map(match => match[1]).sort()
    const shimExports = [...workspaceShim.matchAll(/`export (?:\{ (\w+) \}|\* as (\w+)|const (\w+) =)/g)].map(match => match[1] || match[2] || match[3]).sort()
    const sourceShim = workspaceShim.match(/export const source = \{([^`]+)\}/)?.[1] || ""
    const shimProperties = [...sourceShim.matchAll(/\b(\w+): [^,}]+/g)].map(match => match[1])

    expect(shimExports).toEqual(["defineWorkspace", "source", "useWorkspace"])
    expect(shimProperties.sort()).toEqual(sourceExports)
    expect(viteE2e).toContain('alias["@vite-hub/workspace/internal/runtime/workspace"] = workspaceRuntimeFile')
    expect(viteE2e).toContain('resolve(queuePackageDir, "src/runtime/create-client.ts")')
    expect(viteE2e).not.toContain('export { createQueueClient, deferQueue, getQueue, runQueue }')
    expect(viteE2e).toContain("setQueueRuntimeConfig(queueConfig, createCloudflareQueueRuntimeClient)")
    expect(viteE2e).toContain("setQueueRuntimeConfig(queueConfig, createVercelQueueRuntimeClient)")
    expect(vercelQueueWrapper).toContain("createVercelQueueRuntimeClient")
    expect(vercelQueueWrapper).toContain("}, createVercelQueueRuntimeClient)`")
    expect(viteE2e).not.toContain('"setQueueRuntimeConfig(queueConfig)"')
  })

  it("keeps the Vite e2e KV shim on error-first results", () => {
    const viteE2E = readFileSync(join(repoRoot, "playground", "vite", "build", "vite-e2e.ts"), "utf8")
    const kvShim = viteE2E.slice(
      viteE2E.indexOf("function renderKvRuntimeModule"),
      viteE2E.indexOf("function renderQueueRuntimeModule"),
    )

    expect(kvShim).toContain('resolve(kvPackageDir, "src/errors.ts")')
    for (const operation of ["clear", "del", "get", "has", "keys", "set"]) {
      expect(kvShim).toContain(String.raw`kvResult(\"${operation}\", \"default\"`)
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

      const manifest = readJson(showcaseManifestSchema, manifestPath)

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
