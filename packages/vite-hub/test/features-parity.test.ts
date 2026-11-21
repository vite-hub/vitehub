import { describe, expect, it } from "vitest"

import type { ViteHubHost } from "@vite-hub/internal/deployment"
import type { FeatureId } from "@vite-hub/internal/features"
import { featureIds, features, featureSupport } from "@vite-hub/internal/features"

import { resolveCacheStorage } from "../src/cache-storage.ts"
import { optionalFeaturePackages } from "../src/internal/optional-owners.ts"

const presets: ViteHubHost[] = ["cloudflare", "deno", "netlify", "node", "vercel"]

describe("feature catalog parity with vite-hub", () => {
  it("names the same packages as optionalFeaturePackages", () => {
    for (const id of featureIds) {
      const expected = id === "observability"
        ? ["evlog"]
        : (optionalFeaturePackages as Partial<Record<FeatureId, readonly string[]>>)[id] ?? []
      expect(features[id].packages, id).toEqual(expected)
    }
  })

  it("agrees with resolveCacheStorage about the default store of every preset", () => {
    for (const preset of presets) {
      const native = featureSupport("cache", preset).level === "native"
      if (native) expect(() => resolveCacheStorage(true, preset), preset).not.toThrow()
      else expect(() => resolveCacheStorage(true, preset), preset).toThrow()
    }
  })
})
