import { expect, it } from "vitest"

import { installArguments, missingFeaturePackagesError } from "../src/internal/optional-owners.ts"

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

it("names the packages of the Console MCP client and of the Console components", () => {
  expect(missingFeaturePackagesError(["console mcp-client"]).message).toContain("The console mcp-client feature needs @modelcontextprotocol/sdk.")
  expect(missingFeaturePackagesError(["console ui"]).message).toContain("The console ui feature needs @vite-hub/ui, @json-render/core, @json-render/vue, @vueuse/core.")
})
