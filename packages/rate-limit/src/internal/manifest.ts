import { resolve } from "node:path"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"

import { cloudflareRateLimitDriver } from "../drivers/cloudflare.ts"
import { memoryRateLimitDriver } from "../drivers/memory.ts"
import { createRateLimiter } from "../limiter.ts"

import type { DiscoveredRateLimitDefinition, RateLimitDriverCapabilities } from "../types.ts"

const rateLimitManifestPath = ".vitehub/rate-limit/manifest.json"

interface RateLimitManifestDefinition {
  name: string
  provider: "cloudflare" | "memory"
  capabilities: RateLimitDriverCapabilities
}

interface RateLimitManifest {
  schemaVersion: 1
  definitions: RateLimitManifestDefinition[]
}

function resolveProviderCapabilities(provider: "cloudflare" | "memory"): RateLimitDriverCapabilities {
  const driver = provider === "cloudflare" ? cloudflareRateLimitDriver() : memoryRateLimitDriver()
  return createRateLimiter({ driver, limit: 1, window: "1m" }).capabilities
}

function createRateLimitManifest(
  definitions: DiscoveredRateLimitDefinition[],
  provider: "cloudflare" | "memory",
): RateLimitManifest {
  const capabilities = resolveProviderCapabilities(provider)
  return {
    schemaVersion: 1,
    definitions: [...definitions]
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      .map(definition => ({ name: definition.name, provider, capabilities })),
  }
}

export async function writeRateLimitManifest(
  rootDir: string,
  definitions: DiscoveredRateLimitDefinition[],
  provider: "cloudflare" | "memory",
): Promise<void> {
  const manifest = createRateLimitManifest(definitions, provider)
  await writeFileIfChanged(resolve(rootDir, rateLimitManifestPath), `${JSON.stringify(manifest, null, 2)}\n`)
}
