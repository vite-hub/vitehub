import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { assertFeaturePackages, installArguments, installedPackageVersion, isPackageInstalled, missingFeaturePackagesError, unsupportedPackageVersionsWarning } from "../src/internal/optional-owners.ts"

const sha = "52e6aba01356ffd6c5f1d0d6e8dafc3d63788b82"

it("names the matching pkg.pr.new preview of ViteHub packages when vite-hub is a preview", () => {
  // pnpm pack writes the version into the optional peers. Only the dependencies point at the preview.
  const manifest = {
    dependencies: { "@vite-hub/env": `https://pkg.pr.new/vite-hub/vitehub/@vite-hub/env@${sha}`, "h3": "^2.0.0" },
    peerDependencies: { "@vite-hub/database": "0.1.0" },
    version: "0.1.0",
  }
  expect(installArguments(["@vite-hub/database", "drizzle-orm"], manifest)).toEqual([
    `https://pkg.pr.new/vite-hub/vitehub/@vite-hub/database@${sha}`,
    "drizzle-orm",
  ])
})

it("keeps plain package names when vite-hub comes from npm", () => {
  const manifest = { dependencies: { "@vite-hub/env": "0.1.0" }, version: "0.1.0" }
  expect(installArguments(["@vite-hub/database", "drizzle-orm"], manifest)).toEqual(["@vite-hub/database", "drizzle-orm"])
})

it("tells a Connections app to install the Connections and Database packages", () => {
  expect(missingFeaturePackagesError(["connections"]).message).toContain("The connections feature needs @vite-hub/connections, @vite-hub/database, drizzle-orm.")
})

it.each([
  ["blob", "@vite-hub/blob"],
  ["kv", "@vite-hub/kv"],
  ["queue", "@vite-hub/queue"],
  ["rateLimit", "@vite-hub/rate-limit"],
  ["sandboxTask", "@vite-hub/sandbox"],
  ["workflow", "@vite-hub/workflow"],
] as const)("names the owner package of the %s feature", (feature, packageName) => {
  expect(missingFeaturePackagesError([feature]).message).toContain(`The ${feature} feature needs ${packageName}.`)
})

it("names the packages of the Console MCP client and of the Console components", () => {
  expect(missingFeaturePackagesError(["console mcp-client"]).message).toContain("The console mcp-client feature needs @modelcontextprotocol/sdk.")
  expect(missingFeaturePackagesError(["console ui"]).message).toContain("The console ui feature needs @vite-hub/ui, @json-render/core, @json-render/vue, @vueuse/core.")
})

it("finds installed packages, including one that does not export its manifest", () => {
  expect(isPackageInstalled("@vite-hub/kv")).toBe(true)
  // drizzle-orm does not export ./package.json.
  expect(isPackageInstalled("drizzle-orm")).toBe(true)
  expect(isPackageInstalled("@vite-hub/not-a-package")).toBe(false)
})

describe("unsupportedPackageVersionsWarning", () => {
  const manifest = {
    peerDependencies: { "@vite-hub/database": "0.2.0", "ai": "^6.0.0 || ^7.0.0-0", "drizzle-orm": "^0.45.0", "evlog": "catalog:runtime" },
    version: "0.2.0",
  }
  const versions = (installed: Record<string, string>) => (name: string): string | undefined => installed[name]

  it("does not warn when the installed versions are in range", () => {
    expect(unsupportedPackageVersionsWarning(["@vite-hub/database", "drizzle-orm"], versions({ "@vite-hub/database": "0.2.0", "drizzle-orm": "0.45.2" }), manifest)).toBeUndefined()
  })

  it("names each installed version outside its range and one install command", () => {
    expect(unsupportedPackageVersionsWarning(["@vite-hub/database", "drizzle-orm"], versions({ "@vite-hub/database": "0.1.0", "drizzle-orm": "0.44.0" }), manifest))
      .toBe("[vitehub] @vite-hub/database 0.1.0 is installed, but vite-hub 0.2.0 supports @vite-hub/database@0.2.0. drizzle-orm 0.44.0 is installed, but vite-hub 0.2.0 supports drizzle-orm@^0.45.0. Other versions can fail at runtime with errors that do not name the version. Update vite-hub to a release that supports these versions, or install supported versions in your app with: pnpm add @vite-hub/database@0.2.0 'drizzle-orm@^0.45.0'")
  })

  it("quotes a range that the shell would split", () => {
    const warning = unsupportedPackageVersionsWarning(["drizzle-orm"], versions({ "drizzle-orm": "0.45.2" }), { peerDependencies: { "drizzle-orm": ">=1.0.0-rc.5 <2.0.0" }, version: "0.2.0" })
    expect(warning).toContain("pnpm add 'drizzle-orm@>=1.0.0-rc.5 <2.0.0'")
  })

  it("accepts a prerelease of a supported release line and warns for one of an unsupported line", () => {
    expect(unsupportedPackageVersionsWarning(["ai"], versions({ ai: "7.1.0-canary.2" }), manifest)).toBeUndefined()
    expect(unsupportedPackageVersionsWarning(["drizzle-orm"], versions({ "drizzle-orm": "0.45.3-beta.1" }), manifest)).toBeUndefined()
    expect(unsupportedPackageVersionsWarning(["ai"], versions({ ai: "8.0.0-beta.1" }), manifest)).toContain("ai 8.0.0-beta.1 is installed, but vite-hub 0.2.0 supports ai@^6.0.0 || ^7.0.0-0.")
  })

  it("accepts the pkg.pr.new preview of a ViteHub package and names the preview URL", () => {
    const preview = {
      dependencies: { "@vite-hub/env": `https://pkg.pr.new/vite-hub/vitehub/@vite-hub/env@${sha}` },
      peerDependencies: { "@vite-hub/database": "0.1.0 || 0.0.0-preview-52e6aba" },
      version: "0.0.0-preview-52e6aba",
    }
    expect(unsupportedPackageVersionsWarning(["@vite-hub/database"], versions({ "@vite-hub/database": "0.0.0-preview-52e6aba" }), preview)).toBeUndefined()
    expect(unsupportedPackageVersionsWarning(["@vite-hub/database"], versions({ "@vite-hub/database": "0.0.9" }), preview))
      .toContain(`pnpm add https://pkg.pr.new/vite-hub/vitehub/@vite-hub/database@${sha}`)
  })

  it("does not check a package without a version, or a range that is not semver", () => {
    const versionOf = vi.fn(versions({ "drizzle-orm": "not-a-version" }))
    expect(unsupportedPackageVersionsWarning(["@vite-hub/database", "drizzle-orm", "evlog", "vite"], versionOf, manifest)).toBeUndefined()
    // `catalog:runtime` is a range of a source checkout, and this manifest has no range for `vite`.
    expect(versionOf.mock.calls.map(([name]) => name)).toEqual(["@vite-hub/database", "drizzle-orm"])
  })
})

it("reads the installed version, also of a package that does not export its manifest", () => {
  const drizzle: unknown = JSON.parse(readFileSync(new URL("../node_modules/drizzle-orm/package.json", import.meta.url), "utf8"))
  expect(installedPackageVersion("drizzle-orm")).toBe((drizzle as { version: string }).version)
  expect(installedPackageVersion("@vite-hub/kv")).toMatch(/^\d+\.\d+\.\d+/)
  expect(installedPackageVersion("@vite-hub/not-a-package")).toBeUndefined()
})

it("reads the root manifest when a wildcard export maps package.json to a nested file", () => {
  // The MCP SDK exports `./*` to `./dist/esm/*`, so `@modelcontextprotocol/sdk/package.json` is `{"type":"module"}`.
  const sdk: unknown = JSON.parse(readFileSync(new URL("../node_modules/@modelcontextprotocol/sdk/package.json", import.meta.url), "utf8"))
  const nested: unknown = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@modelcontextprotocol/sdk/package.json")), "utf8"))
  expect(nested).not.toHaveProperty("version")
  expect(installedPackageVersion("@modelcontextprotocol/sdk")).toBe((sdk as { version: string }).version)
})

it("does not warn in a source checkout, where the peer ranges are workspace and catalog ranges", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    assertFeaturePackages(["database", "kv"])
    expect(warn).not.toHaveBeenCalled()
  }
  finally {
    warn.mockRestore()
  }
})

describe("assertFeaturePackages version warning", () => {
  const viteHubManifestFile = fileURLToPath(new URL("../package.json", import.meta.url))

  /** Loads a fresh copy of the module, which reads `published` as the manifest of `vite-hub`. */
  async function withViteHubManifest(published: () => string) {
    vi.resetModules()
    vi.doMock("node:fs", async (importOriginal) => {
      const fs = await importOriginal<typeof import("node:fs")>()
      const readFileSync = ((file: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) =>
        file === viteHubManifestFile ? published() : Reflect.apply(fs.readFileSync, fs, [file, ...rest])) as typeof fs.readFileSync
      return { ...fs, readFileSync, default: { ...fs, readFileSync } }
    })
    try {
      return await import("../src/internal/optional-owners.ts")
    }
    finally {
      vi.doUnmock("node:fs")
    }
  }

  it("warns one time for each package in the process and keeps the build going", async () => {
    const kv = installedPackageVersion("@vite-hub/kv")
    const { assertFeaturePackages } = await withViteHubManifest(() => JSON.stringify({ peerDependencies: { "@vite-hub/database": "9.9.9", "@vite-hub/kv": "9.9.9" }, version: "9.9.9" }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      assertFeaturePackages(["kv"])
      assertFeaturePackages(["kv"])
      assertFeaturePackages(["kv", "database"])
      expect(warn.mock.calls.map(([message]) => String(message).replace(/ Other versions.*/, ""))).toEqual([
        `[vitehub] @vite-hub/kv ${kv} is installed, but vite-hub 9.9.9 supports @vite-hub/kv@9.9.9.`,
        `[vitehub] @vite-hub/database ${installedPackageVersion("@vite-hub/database")} is installed, but vite-hub 9.9.9 supports @vite-hub/database@9.9.9.`,
      ])
    }
    finally {
      warn.mockRestore()
    }
  })

  it("warns for a package whose exported package.json is a nested file", async () => {
    const { assertFeaturePackages } = await withViteHubManifest(() => JSON.stringify({ peerDependencies: { "@modelcontextprotocol/sdk": "^99.0.0" }, version: "9.9.9" }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      assertFeaturePackages(["console mcp-client"])
      expect(warn).toHaveBeenCalledOnce()
      expect(String(warn.mock.calls[0]![0])).toContain(`@modelcontextprotocol/sdk ${installedPackageVersion("@modelcontextprotocol/sdk")} is installed, but vite-hub 9.9.9 supports @modelcontextprotocol/sdk@^99.0.0.`)
    }
    finally {
      warn.mockRestore()
    }
  })

  it("does not stop the build when it cannot read the manifest of vite-hub", async () => {
    const { assertFeaturePackages } = await withViteHubManifest(() => "not json")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(() => assertFeaturePackages(["kv"])).not.toThrow()
      expect(warn).not.toHaveBeenCalled()
    }
    finally {
      warn.mockRestore()
    }
  })
})
