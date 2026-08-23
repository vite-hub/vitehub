import { existsSync, globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import * as ownerAgent from "@vite-hub/agent"
import * as ownerCapabilities from "@vite-hub/agent/capabilities"
import * as ownerAgentEve from "@vite-hub/agent/eve"
import * as ownerAgentVue from "@vite-hub/agent/vue"
import ownerAuthHandler from "@vite-hub/auth/server"
import * as ownerAuthVue from "@vite-hub/auth/vue"
import * as ownerBlobContentType from "@vite-hub/blob/content-type"
import { setActiveCloudflareEnv as ownerCloudflareEnvSetter } from "@vite-hub/database/runtime/cloudflare-env"
import { setActiveCloudflareEnv as ownerDatabaseStateSetter } from "@vite-hub/database/runtime/state"
import * as ownerRateLimit from "@vite-hub/rate-limit"
import * as framework from "vite-hub"
import * as frameworkAgent from "vite-hub/agent"
import * as frameworkAgentEve from "vite-hub/_internal/agent/eve"
import * as frameworkCapabilities from "vite-hub/agent/capabilities"
import * as frameworkAgentVue from "vite-hub/agent/vue"
import frameworkAuthHandler from "vite-hub/auth/server"
import * as frameworkAuthVue from "vite-hub/auth/vue"
import * as frameworkBlobContentType from "vite-hub/blob/content-type"
import * as frameworkRateLimit from "vite-hub/rate-limit"
import * as frameworkRuntimeNode from "vite-hub/runtime/node"
import { setActiveCloudflareEnv as frameworkDatabaseStateSetter } from "vite-hub/_internal/database/runtime/state"
import * as ownerRuntimeNode from "@vite-hub/runtime/node"
import { distributionBinEntries, distributionEntriesFromManifest } from "../vite.config.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))

interface DistributionManifest {
  bin: Record<string, string>
  dependencies: Record<string, string>
  exports: Record<string, string | { import: string; types?: string }>
}

function parseDistributionManifest(text: string): DistributionManifest {
  const value: unknown = JSON.parse(text)
  if (Object(value) !== value) throw new TypeError("Expected a package manifest object.")
  const bin = Reflect.get(Object(value), "bin")
  const dependencies = Reflect.get(Object(value), "dependencies")
  const exports = Reflect.get(Object(value), "exports")
  if (Object(bin) !== bin || Object(dependencies) !== dependencies || Object(exports) !== exports) {
    throw new TypeError("Expected package manifest maps.")
  }
  // SAFETY: The checked package.json fields are the string maps exercised by these distribution tests.
  return { bin, dependencies, exports } as DistributionManifest
}

const manifest = parseDistributionManifest(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

const forwarderExportLine = /^export (?:type )?(?:\*|\{[^}]+\}) from "([^"]+)"$/

const consolidatedOwnerExports = new Set(["@vite-hub/blob/ensure", "@vite-hub/workspace/ai"])

const lowLevelOwnerExports = new Set([
  "@vite-hub/agent/ai-sdk",
  "@vite-hub/agent/cloudflare/state",
  "@vite-hub/agent/eve",
  "@vite-hub/agent/mcp",
  "@vite-hub/agent/mcp/stdio",
  "@vite-hub/agent/messages",
  "@vite-hub/agent/output",
  "@vite-hub/agent/server/workspace",
  "@vite-hub/blob/config",
  "@vite-hub/blob/errors",
  "@vite-hub/database/config",
  "@vite-hub/kv/errors",
  "@vite-hub/workspace/source-metadata",
])

const generatedRuntimeOwnerExports = new Set([
  "@vite-hub/agent/runtime/empty-registry",
  "@vite-hub/agent/runtime/workflow",
  "@vite-hub/blob/runtime/cloudflare-vite",
  "@vite-hub/blob/runtime/state",
  "@vite-hub/blob/runtime/vercel-vite",
  "@vite-hub/database/runtime/agent",
  "@vite-hub/database/runtime/cloudflare-env",
  "@vite-hub/database/runtime/cloudflare-vite",
  "@vite-hub/database/runtime/hosted",
  "@vite-hub/database/runtime/state",
  "@vite-hub/database/runtime/vercel-vite",
  "@vite-hub/database/runtime/virtual-databases",
  "@vite-hub/database/runtime/virtual-schema",
  "@vite-hub/kv/runtime/upstash-driver",
  "@vite-hub/queue/runtime/hosted",
  "@vite-hub/rate-limit/runtime",
  "@vite-hub/sandbox/runtime/empty-registry",
  "@vite-hub/sandbox/runtime/provider-loader",
  "@vite-hub/sandbox/runtime/state",
  "@vite-hub/schedule/runtime/state",
  "@vite-hub/schedule/runtime/static",
  "@vite-hub/workflow/runtime/cloudflare-runner",
  "@vite-hub/workflow/runtime/cloudflare-shared",
  "@vite-hub/workflow/runtime/cloudflare-vite",
  "@vite-hub/workflow/runtime/execute",
  "@vite-hub/workflow/runtime/openworkflow",
  "@vite-hub/workflow/runtime/openworkflow-worker",
  "@vite-hub/workflow/runtime/state",
  "@vite-hub/workflow/runtime/vercel-vite",
])

function sourceForwarderTargets(source: string): string[] | undefined {
  const lines = source
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (!lines.length) return

  const targets: string[] = []
  for (const line of lines) {
    const target = line.match(forwarderExportLine)?.[1]
    if (!target) return
    targets.push(target)
  }
  return targets
}

function ownerSpecifierForDistributionSubpath(subpath: string): string {
  const [owner, ...rest] = subpath.replace(/^\.\/(?:_internal\/)?/, "").split("/")
  return [`@vite-hub/${owner}`, ...rest].join("/")
}

function ownerSpecifier(packageName: string, subpath: string): string {
  return subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`
}

function distributionSubpath(packageName: string, subpath: string): string {
  const owner = packageName.slice("@vite-hub/".length)
  return subpath === "." ? `./${owner}` : `./${owner}${subpath.slice(1)}`
}

function ownerOnlyReason(packageName: string, subpath: string): string | undefined {
  const specifier = ownerSpecifier(packageName, subpath)
  const path = subpath.replace(/^\.\//, "")

  if (subpath === "./package.json") return "package metadata"
  if (packageName === "@vite-hub/cli") return "framework tooling"
  if (/^(?:cli|mountx|nitro|nuxt|test|virtual|vite)(?:\/|$)/.test(path)) return "integration or test tooling"
  if (/(?:^|\/)_?internal(?:\/|$)/.test(path)) return "internal implementation"
  if (/^(?:drivers|providers|sandbox\/providers)(?:\/|$)/.test(path)) return "direct provider adapter"
  if (consolidatedOwnerExports.has(specifier)) return "available from the feature root"
  if (lowLevelOwnerExports.has(specifier)) return "low-level package integration"
  if (generatedRuntimeOwnerExports.has(specifier)) return "generated or provider runtime"
}

describe("framework package contract", () => {
  it("keeps the root export intentionally small", () => {
    expect(Object.keys(framework)).toEqual(["vitehub"])
  })

  it("forwards feature APIs from their owner packages", () => {
    expect(frameworkAgent.defineAgent).not.toBe(ownerAgent.defineAgent)
    expect(frameworkAgentEve.eveExtensionCapability).toBe(ownerAgentEve.eveExtensionCapability)
    expect(frameworkCapabilities.email).toBe(ownerCapabilities.email)
    expect(frameworkCapabilities.workspaceShell).toBe(ownerCapabilities.workspaceShell)
    expect(frameworkAgentVue.useAgent).toBe(ownerAgentVue.useAgent)
    expect(frameworkAgentVue.useChat).toBe(ownerAgentVue.useChat)
    expect(frameworkAuthHandler).toBe(ownerAuthHandler)
    expect(frameworkAuthVue.authClient).toBe(ownerAuthVue.authClient)
    expect(frameworkAuthVue.useUserSession).toBe(ownerAuthVue.useUserSession)
    expect(frameworkBlobContentType.detectContentType).toBe(ownerBlobContentType.detectContentType)
    expect(frameworkRateLimit.requireRateLimit).toBe(ownerRateLimit.requireRateLimit)
    expect(frameworkRateLimit.createRateLimiter).toBe(ownerRateLimit.createRateLimiter)
    expect(frameworkRuntimeNode.nodeRuntimeResources).toBe(ownerRuntimeNode.nodeRuntimeResources)
  })

  it("keeps the Database environment setter on its owner runtime instance", () => {
    expect(ownerCloudflareEnvSetter).toBe(ownerDatabaseStateSetter)
    expect(frameworkDatabaseStateSetter).toBe(ownerDatabaseStateSetter)
  })

  it("keeps every source forwarder owned by its matching package export", () => {
    const manifestEntries = Object.entries(manifest.exports).flatMap(([subpath, target]) =>
      distributionEntriesFromManifest(target).map(source => ({ source, subpath })),
    )
    const manifestForwarders = manifestEntries.flatMap(({ source, subpath }) => {
      const targets = sourceForwarderTargets(readFileSync(`${packageRoot}/${source}`, "utf8"))
      return targets ? [{ source, subpath, targets }] : []
    })
    const sourceForwarders = globSync("src/**/*.ts", { cwd: packageRoot })
      .filter(source => !source.endsWith(".d.ts"))
      .filter(source => sourceForwarderTargets(readFileSync(`${packageRoot}/${source}`, "utf8")))
      .sort()
    const exportedForwarders = new Set(manifestForwarders.map(({ source }) => source))

    expect(sourceForwarders).toEqual([...exportedForwarders].sort())
    expect(
      manifestEntries
        .filter(({ source }) => !exportedForwarders.has(source))
        .map(({ subpath }) => subpath)
        .sort(),
    ).toEqual([
      ".",
      "./_internal/database/runtime/state",
      "./_internal/kv/runtime/disabled-upstash",
      "./agent",
      "./console",
      "./console/server",
      "./database/drizzle",
      "./nuxt",
      "./source",
    ])

    for (const { subpath, targets } of manifestForwarders) {
      const ownerSpecifier = ownerSpecifierForDistributionSubpath(subpath)
      const ownerPackage = ownerSpecifier.split("/").slice(0, 2).join("/")
      expect([...new Set(targets)], subpath).toEqual([ownerSpecifier])
      expect(manifest.dependencies[ownerPackage], subpath).toBeDefined()
    }
  })

  it("classifies every owner-package export", () => {
    const unclassified: string[] = []

    for (const packageName of Object.keys(manifest.dependencies).filter(name => name.startsWith("@vite-hub/"))) {
      const packageDirectory = packageName.slice("@vite-hub/".length)
      const ownerManifest: unknown = JSON.parse(
        readFileSync(`${repoRoot}/packages/${packageDirectory}/package.json`, "utf8"),
      )
      if (Object(ownerManifest) !== ownerManifest) throw new TypeError("Expected an owner manifest.")
      const ownerExports = Reflect.get(Object(ownerManifest), "exports")
      if (ownerExports !== undefined && Object(ownerExports) !== ownerExports) {
        throw new TypeError("Expected an owner export map.")
      }

      for (const subpath of Object.keys(Object(ownerExports))) {
        if (manifest.exports[distributionSubpath(packageName, subpath)]) continue
        if (ownerOnlyReason(packageName, subpath)) continue
        unclassified.push(ownerSpecifier(packageName, subpath))
      }
    }

    expect(unclassified.sort()).toEqual([])
  })

  it("ships every declared export and both CLI names", () => {
    expect(manifest.exports).not.toHaveProperty("./bin")
    expect(manifest.bin).toEqual({
      "vite-hub": "./dist/bin.js",
      vitehub: "./dist/bin.js",
    })

    for (const value of Object.values(manifest.exports)) {
      const target = String(value) === value ? value : Reflect.get(Object(value), "import")
      if (String(target) !== target) throw new TypeError("Expected an export target.")
      if (target === "./package.json") continue
      expect(existsSync(`${packageRoot}/${target}`), target).toBe(true)
    }

    expect(readFileSync(`${packageRoot}/${manifest.bin.vitehub}`, "utf8")).toMatch(/^#!\/usr\/bin\/env node/)
    expect(readFileSync(`${packageRoot}/dist/env.d.ts`, "utf8")).toContain('import "@vite-hub/env/vite"')
    expect(readFileSync(`${packageRoot}/dist/cloudflare-types.d.ts`, "utf8")).toContain("@cloudflare/workers-types")
    expect(existsSync(`${packageRoot}/dist/console/runtime/request.ts`)).toBe(true)
    expect(readFileSync(`${packageRoot}/dist/console/runtime/pages/agents.vue`, "utf8")).toContain('from "../request.ts"')
    expect(manifest.dependencies).toHaveProperty("@cloudflare/workers-types")
  })

  it("derives deduplicated binary entries from the package manifest", () => {
    expect(distributionBinEntries).toEqual({
      "vite-hub": "src/bin.ts",
      vitehub: "src/bin.ts",
    })
    expect(distributionEntriesFromManifest(manifest.bin)).toEqual(["src/bin.ts"])
  })

  it("normalizes conditional export leaves into unique runtime entries", () => {
    expect(
      distributionEntriesFromManifest({
        ".": {
          import: {
            default: "./dist/index.js",
            node: "./dist/index.js",
          },
          types: "./dist/index.d.ts",
        },
        "./feature": [{ types: "./dist/feature.d.ts" }, { import: "./dist/feature.js" }],
        "./package.json": "./package.json",
      }),
    ).toEqual(["src/feature.ts", "src/index.ts"])
  })
})
