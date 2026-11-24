import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"
import { inspect } from "node:util"

import { describe, expect, it, vi } from "vitest"

import { assertFeaturePackages, hostFeaturePackages, installArguments, installedPackageVersion, isPackageInstalled, missingFeaturePackagesError, unsupportedPackageVersionsWarning, unsupportedPeerPackagesError, unsupportedViteHubPackagesError } from "../src/internal/optional-owners.ts"

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

it("installs every package that it names, also one that another dependency provides", () => {
  // The repository installs both packages, as an app does when only drizzle-orm is missing.
  expect(missingFeaturePackagesError(["console agents"]).message).toContain("The console agents feature needs @libsql/client, drizzle-orm. Install them in your app with: pnpm add @libsql/client drizzle-orm")
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

it("names the packages of the Console components", () => {
  expect(missingFeaturePackagesError(["console ui"]).message).toContain("The console ui feature needs @vite-hub/ui, @json-render/core, @json-render/vue, @vueuse/core.")
})

it("finds installed packages, including one that does not export its manifest", () => {
  expect(isPackageInstalled("@vite-hub/kv")).toBe(true)
  // drizzle-orm does not export ./package.json.
  expect(isPackageInstalled("drizzle-orm")).toBe(true)
  expect(isPackageInstalled("@vite-hub/not-a-package")).toBe(false)
})

describe("unsupportedViteHubPackagesError", () => {
  const versions = (installed: Record<string, string>) => (name: string): string | undefined => installed[name]

  it("names each ViteHub package, both versions, and the install that aligns them, including pnpm overrides", () => {
    // A preview of vite-hub with the ViteHub packages of an earlier preview, as when pnpm `overrides` pin them.
    const preview = {
      dependencies: { "@vite-hub/env": `https://pkg.pr.new/vite-hub/vitehub/@vite-hub/env@${sha}` },
      peerDependencies: { "@vite-hub/agent": "0.1.0 || 0.0.0-preview-52e6aba", "@vite-hub/kv": "0.1.0 || 0.0.0-preview-52e6aba" },
      version: "0.0.0-preview-52e6aba",
    }
    const error = unsupportedViteHubPackagesError(["@vite-hub/agent", "@vite-hub/kv"], versions({ "@vite-hub/agent": "0.0.0-preview-8724a59", "@vite-hub/kv": "0.0.0-preview-52e6aba" }), preview)
    expect(error).toMatchObject({
      code: "VITE_HUB_PACKAGE_VERSION_UNSUPPORTED",
      fix: `Install the ViteHub packages of the same release as vite-hub: \`pnpm add https://pkg.pr.new/vite-hub/vitehub/@vite-hub/agent@${sha}\`. When pnpm \`overrides\`, \`resolutions\`, or the lockfile pin a @vite-hub package, change them to the same release too, then install again.`,
      why: "@vite-hub/agent 0.0.0-preview-8724a59 is installed, but vite-hub 0.0.0-preview-52e6aba supports @vite-hub/agent@0.1.0 || 0.0.0-preview-52e6aba. ViteHub packages of another release do not work with this vite-hub. The app can build and then fail at runtime, or run the code of the other release.",
    })
  })

  it("accepts ViteHub packages in range and leaves other packages to the warning", () => {
    const manifest = { peerDependencies: { "@vite-hub/database": "0.2.0", "drizzle-orm": "^0.45.0" }, version: "0.2.0" }
    expect(unsupportedViteHubPackagesError(["@vite-hub/database", "drizzle-orm"], versions({ "@vite-hub/database": "0.2.0", "drizzle-orm": "0.44.0" }), manifest)).toBeUndefined()
    expect(unsupportedPackageVersionsWarning(["@vite-hub/database", "drizzle-orm"], versions({ "@vite-hub/database": "0.1.0", "drizzle-orm": "0.45.2" }), manifest)).toBeUndefined()
  })
})

describe("unsupportedPackageVersionsWarning", () => {
  const manifest = {
    peerDependencies: { "@libsql/client": "^0.18.0", "@vite-hub/database": "0.2.0", "ai": "^6.0.0 || ^7.0.0-0", "drizzle-orm": "^0.45.0", "evlog": "catalog:runtime" },
    version: "0.2.0",
  }
  const versions = (installed: Record<string, string>) => (name: string): string | undefined => installed[name]

  it("does not warn when the installed versions are in range", () => {
    expect(unsupportedPackageVersionsWarning(["@vite-hub/database", "drizzle-orm"], versions({ "@vite-hub/database": "0.2.0", "drizzle-orm": "0.45.2" }), manifest)).toBeUndefined()
  })

  it("names each installed version outside its range and one install command", () => {
    expect(unsupportedPackageVersionsWarning(["ai", "@libsql/client"], versions({ "ai": "5.0.0", "@libsql/client": "0.14.0" }), manifest))
      .toBe("[vitehub] ai 5.0.0 is installed, but vite-hub 0.2.0 supports ai@^6.0.0 || ^7.0.0-0. @libsql/client 0.14.0 is installed, but vite-hub 0.2.0 supports @libsql/client@^0.18.0. Other versions can fail at runtime with errors that do not name the version. Update vite-hub to a release that supports these versions, or install supported versions in your app with: pnpm add 'ai@^6.0.0 || ^7.0.0-0' '@libsql/client@^0.18.0'")
  })

  it("leaves drizzle-orm to the error", () => {
    expect(unsupportedPackageVersionsWarning(["drizzle-orm"], versions({ "drizzle-orm": "0.44.0" }), manifest)).toBeUndefined()
  })

  it("quotes a range that the shell would split", () => {
    const warning = unsupportedPackageVersionsWarning(["ai"], versions({ ai: "5.0.0" }), { peerDependencies: { ai: ">=6.0.0 <8.0.0" }, version: "0.2.0" })
    expect(warning).toContain("pnpm add 'ai@>=6.0.0 <8.0.0'")
  })

  it("accepts a prerelease of a supported release line and warns for one of an unsupported line", () => {
    expect(unsupportedPackageVersionsWarning(["ai"], versions({ ai: "7.1.0-canary.2" }), manifest)).toBeUndefined()
    expect(unsupportedPackageVersionsWarning(["@libsql/client"], versions({ "@libsql/client": "0.18.1-pre.1" }), manifest)).toBeUndefined()
    expect(unsupportedPackageVersionsWarning(["ai"], versions({ ai: "8.0.0-beta.1" }), manifest)).toContain("ai 8.0.0-beta.1 is installed, but vite-hub 0.2.0 supports ai@^6.0.0 || ^7.0.0-0.")
  })

  it("accepts the pkg.pr.new preview of a ViteHub package and names the preview URL", () => {
    const preview = {
      dependencies: { "@vite-hub/env": `https://pkg.pr.new/vite-hub/vitehub/@vite-hub/env@${sha}` },
      peerDependencies: { "@vite-hub/database": "0.1.0 || 0.0.0-preview-52e6aba" },
      version: "0.0.0-preview-52e6aba",
    }
    expect(unsupportedViteHubPackagesError(["@vite-hub/database"], versions({ "@vite-hub/database": "0.0.0-preview-52e6aba" }), preview)).toBeUndefined()
    expect(unsupportedViteHubPackagesError(["@vite-hub/database"], versions({ "@vite-hub/database": "0.0.9" }), preview)?.fix)
      .toContain(`pnpm add https://pkg.pr.new/vite-hub/vitehub/@vite-hub/database@${sha}`)
  })

  it("does not check a package without a version, or a range that is not semver", () => {
    const versionOf = vi.fn(versions({ "ai": "not-a-version", "drizzle-orm": "not-a-version" }))
    expect(unsupportedPackageVersionsWarning(["ai", "evlog", "vite"], versionOf, manifest)).toBeUndefined()
    expect(unsupportedPeerPackagesError(["drizzle-orm"], versionOf, manifest)).toBeUndefined()
    expect(unsupportedViteHubPackagesError(["@vite-hub/database"], versionOf, manifest)).toBeUndefined()
    // `catalog:runtime` is a range of a source checkout, and this manifest has no range for `vite`.
    expect(versionOf.mock.calls.map(([name]) => name)).toEqual(["ai", "drizzle-orm", "@vite-hub/database"])
  })
})

describe("unsupportedPeerPackagesError", () => {
  const manifest = { peerDependencies: { "ai": "^7.0.0", "drizzle-orm": "1.0.0-rc.5 || ^1.0.0" }, version: "0.3.1" }
  const versions = (installed: Record<string, string>) => (name: string): string | undefined => installed[name]

  it("names drizzle-orm 0.x, the supported range, and the quoted install", () => {
    // pnpm satisfies the optional peer with the 0.44.7 that the lockfile or another dependency has, and only warns.
    expect(unsupportedPeerPackagesError(["ai", "drizzle-orm"], versions({ "ai": "5.0.0", "drizzle-orm": "0.44.7" }), manifest)).toMatchObject({
      code: "VITE_HUB_PEER_VERSION_UNSUPPORTED",
      fix: expect.stringContaining("pnpm add 'drizzle-orm@1.0.0-rc.5 || ^1.0.0'"),
      why: expect.stringMatching(/^drizzle-orm 0\.44\.7 is installed, but vite-hub 0\.3\.1 supports drizzle-orm@1\.0\.0-rc\.5 \|\| \^1\.0\.0\. .*drizzle-orm\/libsql\/codecs/),
    })
  })

  it("accepts drizzle-orm in range and leaves other packages to the warning", () => {
    expect(unsupportedPeerPackagesError(["drizzle-orm"], versions({ "drizzle-orm": "1.0.0-rc.5" }), manifest)).toBeUndefined()
    expect(unsupportedPeerPackagesError(["drizzle-orm"], versions({ "drizzle-orm": "1.0.2" }), manifest)).toBeUndefined()
    expect(unsupportedPeerPackagesError(["ai"], versions({ ai: "5.0.0" }), manifest)).toBeUndefined()
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

describe("assertFeaturePackages version check", () => {
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

  it("stops the build for a ViteHub package of another release, every time it checks", async () => {
    const kv = installedPackageVersion("@vite-hub/kv")
    const { assertFeaturePackages } = await withViteHubManifest(() => JSON.stringify({ peerDependencies: { "@vite-hub/kv": "9.9.9" }, version: "9.9.9" }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const printed = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const error = { code: "VITE_HUB_PACKAGE_VERSION_UNSUPPORTED", why: expect.stringContaining(`@vite-hub/kv ${kv} is installed, but vite-hub 9.9.9 supports @vite-hub/kv@9.9.9.`) }
      expect(() => assertFeaturePackages(["kv"])).toThrow(expect.objectContaining(error))
      expect(() => assertFeaturePackages(["kv"])).toThrow(expect.objectContaining(error))
      expect(warn).not.toHaveBeenCalled()
      // The build log shows the fix, which a thrown error alone does not.
      expect(printed).toHaveBeenCalledTimes(2)
      expect(String(printed.mock.calls[0]![0])).toContain("pnpm add @vite-hub/kv@9.9.9")
      expect(String(printed.mock.calls[0]![0])).toContain("pnpm `overrides`")
    }
    finally {
      warn.mockRestore()
      printed.mockRestore()
    }
  })

  it("lets Vite print an unsupported version once with the fix last", async () => {
    await withViteHubManifest(() => JSON.stringify({ peerDependencies: { "@vite-hub/kv": "9.9.9" }, version: "9.9.9" }))
    const { vitehub } = await import("../src/index.ts")
    const printed = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const configure = () => vitehub({ kv: true, console: false })
      expect(configure).toThrow(expect.objectContaining({ code: "VITE_HUB_PACKAGE_VERSION_UNSUPPORTED" }))
      expect(printed).not.toHaveBeenCalled()
      try {
        configure()
      }
      catch (error) {
        const lines = inspect(error).split("\n")
        expect(lines).toHaveLength(3)
        expect(lines[1]).toContain("see: ")
        expect(lines[2]).toContain("fix: ")
      }
    }
    finally {
      printed.mockRestore()
    }
  })

  it("warns one time for another package outside its range and keeps the build going", async () => {
    const { assertFeaturePackages } = await withViteHubManifest(() => JSON.stringify({ peerDependencies: { "@libsql/client": "^99.0.0" }, version: "9.9.9" }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      assertFeaturePackages(["console agents"])
      assertFeaturePackages(["console agents"])
      expect(warn.mock.calls.map(([message]) => String(message).replace(/ Other versions.*/, ""))).toEqual([
        `[vitehub] @libsql/client ${installedPackageVersion("@libsql/client")} is installed, but vite-hub 9.9.9 supports @libsql/client@^99.0.0.`,
      ])
    }
    finally {
      warn.mockRestore()
    }
  })

  it("stops the database build for drizzle-orm outside its range, every time it checks", async () => {
    const { assertFeaturePackages } = await withViteHubManifest(() => JSON.stringify({ peerDependencies: { "drizzle-orm": "^99.0.0" }, version: "9.9.9" }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const printed = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const error = { code: "VITE_HUB_PEER_VERSION_UNSUPPORTED", why: expect.stringContaining(`drizzle-orm ${installedPackageVersion("drizzle-orm")} is installed, but vite-hub 9.9.9 supports drizzle-orm@^99.0.0.`) }
      expect(() => assertFeaturePackages(["database"])).toThrow(expect.objectContaining(error))
      expect(() => assertFeaturePackages(["database"])).toThrow(expect.objectContaining(error))
      expect(warn).not.toHaveBeenCalled()
      expect(String(printed.mock.calls[0]![0])).toContain("pnpm add 'drizzle-orm@^99.0.0'")
    }
    finally {
      warn.mockRestore()
      printed.mockRestore()
    }
  })

  it("warns for a package whose exported package.json is a nested file", async () => {
    const { assertFeaturePackages } = await withViteHubManifest(() => JSON.stringify({ peerDependencies: { "@json-render/core": "^99.0.0" }, version: "9.9.9" }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      assertFeaturePackages(["console ui"])
      expect(warn).toHaveBeenCalledOnce()
      expect(String(warn.mock.calls[0]![0])).toContain(`@json-render/core ${installedPackageVersion("@json-render/core")} is installed, but vite-hub 9.9.9 supports @json-render/core@^99.0.0.`)
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

/** Records the lookups of `packageName`. A hidden package fails to resolve, as a package that is not installed. */
function watchPackage(packageName: string) {
  const watched = { hidden: false, lookups: [] as string[] }
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) return nextResolve(specifier, context)
      watched.lookups.push(specifier)
      if (watched.hidden) throw Object.assign(new Error(`Cannot find package '${specifier}'`), { code: "ERR_MODULE_NOT_FOUND" })
      return nextResolve(specifier, context)
    },
  })
  return Object.assign(watched, { stop: () => hooks.deregister() })
}

async function importOptionalOwners() {
  vi.resetModules()
  return await import("../src/internal/optional-owners.ts")
}

it("looks up each package one time in a process", async () => {
  const { isPackageInstalled } = await importOptionalOwners()
  const installed = watchPackage("@vite-hub/kv")
  const missing = watchPackage("@vite-hub/not-a-package")
  try {
    for (let check = 0; check < 3; check++) {
      expect(isPackageInstalled("@vite-hub/kv")).toBe(true)
      expect(isPackageInstalled("@vite-hub/not-a-package")).toBe(false)
    }
  }
  finally {
    installed.stop()
    missing.stop()
  }
  expect(installed.lookups).toEqual(["@vite-hub/kv/package.json"])
  expect(missing.lookups).toEqual(["@vite-hub/not-a-package/package.json"])
})

it("finds a package that the app installs after the error that names it", async () => {
  const { assertFeaturePackages } = await importOptionalOwners()
  const kv = watchPackage("@vite-hub/kv")
  try {
    kv.hidden = true
    expect(() => assertFeaturePackages(["kv"])).toThrow("pnpm add @vite-hub/kv")
    kv.hidden = false
    expect(() => assertFeaturePackages(["kv"])).not.toThrow()
  }
  finally {
    kv.stop()
  }
})

it("sees a removed package after it forgets the checks", async () => {
  const { forgetPackageChecks, isPackageInstalled } = await importOptionalOwners()
  const kv = watchPackage("@vite-hub/kv")
  try {
    expect(isPackageInstalled("@vite-hub/kv")).toBe(true)
    kv.hidden = true
    expect(isPackageInstalled("@vite-hub/kv")).toBe(true)
    forgetPackageChecks()
    expect(isPackageInstalled("@vite-hub/kv")).toBe(false)
  }
  finally {
    kv.stop()
  }
})

it("sees a package that the app installed before a Vite restart", async () => {
  const { isPackageInstalled, startPackageChecks } = await importOptionalOwners()
  const kv = watchPackage("@vite-hub/kv")
  try {
    kv.hidden = true
    // The import of `vite-hub` checks the package before Vite loads the app config.
    expect(isPackageInstalled("@vite-hub/kv")).toBe(false)
    startPackageChecks()
    expect(isPackageInstalled("@vite-hub/kv")).toBe(false)
    kv.hidden = false
    // Vite loads the config of the new server before it closes the old one.
    startPackageChecks()
    expect(isPackageInstalled("@vite-hub/kv")).toBe(true)
  }
  finally {
    kv.stop()
  }
  expect(kv.lookups).toEqual(["@vite-hub/kv/package.json", "@vite-hub/kv/package.json"])
})

describe("host packages", () => {
  it("adds the SDKs that the host or the provider of a feature needs", () => {
    expect(hostFeaturePackages(["kv", "queue", "sandboxTask", "workflow"], "vercel", { kv: true, queue: true, sandboxTask: true, workflow: true })).toEqual({
      queue: ["@vercel/queue", "@vercel/functions"],
      sandboxTask: ["@vercel/sandbox"],
      workflow: ["@vercel/functions"],
    })
    expect(hostFeaturePackages(["queue"], "node", { queue: { driver: "postgres" } })).toEqual({ queue: ["postgres"] })
    expect(hostFeaturePackages(["workflow"], "vercel", { workflow: { driver: "openworkflow" } })).toEqual({})
    expect(hostFeaturePackages(["queue", "workflow"], "node", { queue: true, workflow: true })).toEqual({})
  })

  it("stops a Vercel Workflow build that misses @vercel/functions with the install command", async () => {
    const { assertFeaturePackages, hostFeaturePackages } = await importOptionalOwners()
    // `importOptionalOwners()` loads a new catalog, and a catalog guard matches only its own errors.
    const { viteHubErrorDiagnostics } = await import("../src/error-diagnostics.ts")
    const functions = watchPackage("@vercel/functions")
    let error: unknown
    try {
      functions.hidden = true
      assertFeaturePackages(["workflow"], hostFeaturePackages(["workflow"], "vercel", { workflow: true }))
    }
    catch (caught) {
      error = caught
    }
    finally {
      functions.stop()
    }
    expect(viteHubErrorDiagnostics.VITE_HUB_R0136.is(error)).toBe(true)
    expect(error).toHaveProperty("message", "[vitehub] The workflow feature needs @vite-hub/workflow, @vercel/functions. Install them in your app with: pnpm add @vite-hub/workflow @vercel/functions")
  })

  it("resolves a host SDK from the owner package that loads it", async () => {
    // `vite-hub` does not declare `@vercel/queue`. `@vite-hub/queue` does, so pnpm links it there.
    const { assertFeaturePackages, hostFeaturePackages } = await importOptionalOwners()
    expect(() => assertFeaturePackages(["queue"], hostFeaturePackages(["queue"], "vercel", { queue: true }))).not.toThrow()
  })
})
