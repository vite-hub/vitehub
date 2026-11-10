import { registerHooks } from "node:module"

import { expect, it, vi } from "vitest"

import { installArguments, isPackageInstalled, missingFeaturePackagesError } from "../src/internal/optional-owners.ts"

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
