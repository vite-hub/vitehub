import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"

import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isStringLiteralLike,
  type Node,
  ScriptTarget,
  SyntaxKind,
} from "typescript"
import { describe, expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "..")
const effectVersion = "4.0.0-beta.99"
const expectedEffectOwners = ["agent", "internal", "schedule", "source"]
const allowedEffectOwners = new Set(expectedEffectOwners)

type PackageEffectOwnership = {
  declaresEffect: boolean
  importsEffect: boolean
  name: string
  private: boolean
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

function parseJsonObject(source: string, label: string): Record<string, unknown> {
  const value: unknown = JSON.parse(source)
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} must contain a JSON object.`)
  }
  return value
}

async function readFiles(dir: string, predicate: (path: string) => boolean): Promise<string[]> {
  if (!existsSync(dir)) return []
  const files = (await readdir(dir, { recursive: true }))
    .filter(path => predicate(path))
  return Promise.all(files.map(path => readFile(join(dir, path), "utf8")))
}

function sourceImportsEffect(source: string): boolean {
  const sourceFile = createSourceFile("effect-owner.ts", source, ScriptTarget.Latest, true)
  let importsEffect = false
  const visit = (node: Node) => {
    let specifier: Node | undefined
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      specifier = node.moduleSpecifier
    } else if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
      specifier = node.moduleReference.expression
    } else if (isCallExpression(node) && (
      node.expression.kind === SyntaxKind.ImportKeyword
      || (isIdentifier(node.expression) && node.expression.text === "require")
    )) {
      specifier = node.arguments[0]
    }
    if (specifier && isStringLiteralLike(specifier) && /^(?:effect)(?:\/|$)/.test(specifier.text)) {
      importsEffect = true
      return
    }
    forEachChild(node, visit)
  }
  forEachChild(sourceFile, visit)
  return importsEffect
}

async function packageEffectOwnership(): Promise<PackageEffectOwnership[]> {
  const packagesDir = join(repoRoot, "packages")
  const packages: PackageEffectOwnership[] = []
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const packageDir = join(packagesDir, entry.name)
    const sources = await readFiles(join(packageDir, "src"), path => /\.[cm]?[jt]sx?$/.test(path))
    const manifestPath = join(packageDir, "package.json")
    const manifest = parseJsonObject(await readFile(manifestPath, "utf8"), manifestPath)
    const dependencyGroups = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
    const declaresEffect = dependencyGroups.some((group) => {
      const dependencies = manifest[group]
      return isJsonObject(dependencies) && "effect" in dependencies
    })
    packages.push({
      declaresEffect,
      importsEffect: sources.some(sourceImportsEffect),
      name: entry.name,
      private: manifest.private === true,
    })
  }
  return packages
}

function effectOwnershipViolations(packages: PackageEffectOwnership[]): string[] {
  const violations: string[] = []
  for (const pkg of packages) {
    if (pkg.importsEffect && !allowedEffectOwners.has(pkg.name)) {
      violations.push(`${pkg.name}: unauthorized Effect importer`)
    }
    if (pkg.declaresEffect && !allowedEffectOwners.has(pkg.name)) {
      violations.push(`${pkg.name}: unauthorized Effect dependency owner`)
    }
    if (pkg.importsEffect !== pkg.declaresEffect) {
      violations.push(`${pkg.name}: Effect importer and dependency ownership differ`)
    }
  }
  return violations
}

function lockOwnerForV3References(lockfile: string) {
  let owner = ""
  const owners: string[] = []
  for (const line of lockfile.split("\n")) {
    const packageEntry = /^  (\S.*):$/.exec(line)
    if (packageEntry) owner = packageEntry[1]!
    if (/effect@3\.|effect:\s*[\^~]?3\./.test(line)) owners.push(owner)
  }
  return owners
}

describe("Effect ownership", () => {
  it("pins every ViteHub Effect importer to the owned Effect 4 catalog", async () => {
    const workspace = await readFile(join(repoRoot, "pnpm-workspace.yaml"), "utf8")
    expect(workspace).toContain(`  effect:\n    effect: ${effectVersion}`)

    const packages = await packageEffectOwnership()
    expect(effectOwnershipViolations(packages)).toEqual([])
    const owners = packages.filter(pkg => pkg.importsEffect).sort((a, b) => a.name.localeCompare(b.name))
    expect(owners.map(owner => owner.name)).toEqual(expectedEffectOwners)
    for (const pkg of owners) {
      const owner = pkg.name
      const packageDir = join(repoRoot, "packages", owner)
      const manifestPath = join(packageDir, "package.json")
      const manifest = parseJsonObject(await readFile(manifestPath, "utf8"), manifestPath)
      const dependencies = manifest.dependencies
      const declaredEffect = isJsonObject(dependencies) ? dependencies.effect : undefined
      expect(declaredEffect, manifestPath).toBe("catalog:effect")

      const effectPackage = createRequire(manifestPath).resolve("effect/package.json")
      const resolved = parseJsonObject(await readFile(effectPackage, "utf8"), effectPackage)
      expect(resolved.version, packageDir).toBe(effectVersion)

      const declarations = await readFiles(join(packageDir, "dist"), path => path.endsWith(".d.ts"))
      if (!pkg.private) {
        expect(declarations.some(sourceImportsEffect), packageDir).toBe(false)
        expect(
          declarations.some(source => /\bFiberFailure\b/.test(source)),
          packageDir,
        ).toBe(false)
      }

      const bundles = (await readFiles(join(packageDir, "dist"), path => /\.[cm]?js$/.test(path))).join("\n")
      expect(bundles, packageDir).not.toMatch(/effect@3\.|3\.17\.7/)
    }
  }, 30_000)

  it.each([
    {
      fixture: [{ declaresEffect: true, importsEffect: true, name: "queue", private: false }],
      violation: "queue: unauthorized Effect importer",
    },
    {
      fixture: [{ declaresEffect: true, importsEffect: false, name: "schedule", private: false }],
      violation: "schedule: Effect importer and dependency ownership differ",
    },
    {
      fixture: [{ declaresEffect: false, importsEffect: true, name: "workspace", private: false }],
      violation: "workspace: Effect importer and dependency ownership differ",
    },
  ])("rejects invalid Effect ownership: $violation", ({ fixture, violation }) => {
    expect(effectOwnershipViolations(fixture)).toContain(violation)
  })

  it.each([
    'import type { Effect } from "effect"',
    'export type { Effect } from "effect"',
    'export { Effect } from "effect"',
    'import "effect/Schema"',
    'const effect = import("effect")',
    "const effect = import(`effect`)",
    'import "\\u0065ffect"',
    'const effect = require("effect")',
    'import Effect = require("effect")',
  ])("detects Effect ownership syntax in %s", (source) => {
    expect(sourceImportsEffect(source)).toBe(true)
  })

  it("isolates the optional Effect 3 subtree to UploadThing", async () => {
    const lockfile = await readFile(join(repoRoot, "pnpm-lock.yaml"), "utf8")
    const owners = lockOwnerForV3References(lockfile)
    expect(owners.length).toBeGreaterThan(0)
    expect(owners.filter(owner => !(
      owner.startsWith("effect@3.")
      || owner.startsWith("'@effect/platform@")
      || owner.startsWith("'@uploadthing/shared@")
      || owner.startsWith("uploadthing@")
    ))).toEqual([])
  })
})
