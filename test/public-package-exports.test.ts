import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { publicPackageBinContracts, publicPackageExportContracts } from "./public-package-exports"
import { packageDir, packageInfos, readPackageManifest } from "./utils/repo"

describe("public package export contracts", () => {
  it("classifies every public root and subpath exactly once", () => {
    const expected = packageInfos.flatMap((info) => {
      const manifest = readPackageManifest(info.name)
      return Object.keys(manifest.exports || {}).map(subpath => `${info.packageName}:${subpath}`)
    }).sort()
    const actual = publicPackageExportContracts
      .map(contract => `${contract.packageName}:${contract.subpath}`)
      .sort()

    expect(new Set(actual).size).toBe(actual.length)
    expect(actual).toEqual(expected)
    expect(new Set(publicPackageExportContracts.map(contract => contract.kind))).toEqual(new Set([
      "cli",
      "framework-hook",
      "node-import",
      "provider-specific",
      "static-asset",
    ]))
  })

  it("marks eager exports as optional-peer consumers", () => {
    const eagerPeerExports = new Map<string, string>([
      ["@vite-hub/auth/agent", "@vite-hub/agent"],
      ["@vite-hub/auth/nuxt", "vite"],
      ["@vite-hub/source/client", "vue"],
      ["@vite-hub/workspace/collections/client", "vue"],
      ["vite-hub", "vite"],
      ["vite-hub/nuxt", "vite"],
      ["vite-hub/source/client", "vue"],
      ["vite-hub/ui", "vue"],
      ["vite-hub/ui/headless", "vue"],
      ["vite-hub/workspace/collections/client", "vue"],
    ])

    for (const [specifier, peer] of eagerPeerExports) {
      expect(publicPackageExportContracts.find(contract => contract.specifier === specifier)?.optionalRuntimePeers)
        .toContain(peer)
    }
  })

  it("keeps lazy optional peer exports runnable without their declaration peers", () => {
    const lazyPeerExports = new Map<string, string>([
      ["@vite-hub/agent", "@vite-hub/workflow"],
      ["@vite-hub/agent/runtime/workflow", "@vite-hub/workflow"],
      ["@vite-hub/auth/vite", "vite"],
      ["@vite-hub/browser/controllers/playwright", "playwright-core"],
      ["@vite-hub/workflow/runtime/openworkflow", "openworkflow"],
      ["@vite-hub/workflow/runtime/openworkflow-worker", "openworkflow"],
      ["vite-hub/browser/controllers/playwright", "playwright-core"],
      ["vite-hub/ui/nuxt", "vue"],
    ])

    for (const [specifier, peer] of lazyPeerExports) {
      const contract = publicPackageExportContracts.find(contract => contract.specifier === specifier)
      expect(contract?.optionalRuntimePeers).not.toContain(peer)
      expect(contract?.optionalDeclarationPeers).toContain(peer)
    }
  })

  it("publishes declaration dependencies where isolated consumers can resolve them", () => {
    for (const packageName of ["agent", "auth"]) {
      const manifest = readPackageManifest(packageName)
      for (const dependency of ["@types/json-schema", "@types/mdast"]) {
        expect(manifest.peerDependencies?.[dependency], `${packageName} should expose ${dependency}`).toEqual(expect.any(String))
        expect(manifest.peerDependenciesMeta?.[dependency]?.optional, `${packageName} should require ${dependency}`).not.toBe(true)
      }
    }
  })

  it("publishes Better Auth host declarations in its dependency closure", () => {
    const manifest = readPackageManifest("auth")
    for (const dependency of ["@cloudflare/workers-types", "@types/node", "bun-types"]) {
      expect(manifest.dependencies?.[dependency], `auth should install ${dependency}`).toEqual(expect.any(String))
    }
    const hostDeclarations = readFileSync(join(packageDir("auth"), "src/host-declarations.d.ts"), "utf8")
    expect(hostDeclarations).toContain("interface Timer")
    expect(hostDeclarations).not.toMatch(/interface Timer extends NodeJS\.Timer/)
  })

  it("keeps Blob declarations independent from H3 host declarations", () => {
    const source = readFileSync(join(packageDir("blob"), "src/types.ts"), "utf8")
    expect(source).not.toMatch(/from ["']h3["']/)
  })

  it("points every contract at a built artifact", () => {
    for (const contract of publicPackageExportContracts) {
      const info = packageInfos.find(info => info.packageName === contract.packageName)!
      const target = join(packageDir(info.name), contract.target.replace(/^\.\//, ""))

      expect(existsSync(target), `${contract.specifier} should publish ${contract.target}`).toBe(true)
    }
  })

  it("declares every optional peer used by an export contract", () => {
    for (const contract of publicPackageExportContracts) {
      const info = packageInfos.find(info => info.packageName === contract.packageName)!
      const manifest = readPackageManifest(info.name)
      for (const peer of new Set([...contract.optionalDeclarationPeers, ...contract.optionalRuntimePeers])) {
        expect(manifest.peerDependencies?.[peer], `${contract.specifier} should declare ${peer}`).toEqual(expect.any(String))
        expect(manifest.peerDependenciesMeta?.[peer]?.optional, `${contract.specifier} should keep ${peer} optional`).toBe(true)
      }
    }
  })

  it("classifies every executable and keeps its built target runnable", () => {
    const expected = packageInfos.flatMap((info) => {
      const manifest = readPackageManifest(info.name)
      return Object.entries(manifest.bin || {}).map(([binName, target]) => `${info.packageName}:${binName}:${target}`)
    }).sort()
    const actual = publicPackageBinContracts
      .map(contract => `${contract.packageName}:${contract.binName}:${contract.target}`)
      .sort()

    expect(actual).toEqual(expected)
    for (const contract of publicPackageBinContracts) {
      const info = packageInfos.find(info => info.packageName === contract.packageName)!
      const target = join(packageDir(info.name), contract.target.replace(/^\.\//, ""))
      expect(readFileSync(target, "utf8")).toMatch(/^#!\/usr\/bin\/env node/)
      expect(statSync(target).mode & 0o111, `${contract.packageName} ${contract.binName} should be executable`).not.toBe(0)
    }
  })
})
