import { resolve } from "node:path"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"

import { cloudflareRateLimitDriver } from "../drivers/cloudflare.ts"
import { kvRateLimitDriver } from "../drivers/kv.ts"
import { memoryRateLimitDriver } from "../drivers/memory.ts"
import { createRateLimiter } from "../limiter.ts"

import type { RateLimitDeclaration, RateLimitDriverCapabilities } from "../types.ts"

const rateLimitManifestPath = ".vitehub/rate-limit/manifest.json"

type RateLimitManifestProvider = "cloudflare" | "kv" | "memory"

interface RateLimitManifestEntry {
  name: string
  provider: RateLimitManifestProvider
  capabilities: RateLimitDriverCapabilities
}

interface RateLimitManifest {
  schemaVersion: 2
  rateLimits: RateLimitManifestEntry[]
}

const unusedResult = async (): Promise<[error: undefined, data: undefined]> => [undefined, undefined]

function resolveProviderCapabilities(provider: RateLimitManifestProvider): RateLimitDriverCapabilities {
  const driver = provider === "cloudflare"
    ? cloudflareRateLimitDriver({ binding: { limit: async () => ({ success: true }) } })
    : provider === "kv"
      ? kvRateLimitDriver({ storage: { delete: unusedResult, get: unusedResult, increment: async () => [undefined, 0] } })
      : memoryRateLimitDriver()
  return createRateLimiter({ driver, limit: 1, window: "1m" }).capabilities
}

function createRateLimitManifest(
  declarations: RateLimitDeclaration[],
  provider: RateLimitManifestProvider,
): RateLimitManifest {
  const capabilities = resolveProviderCapabilities(provider)
  return {
    schemaVersion: 2,
    rateLimits: [...declarations]
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      .map(definition => ({ name: definition.name, provider, capabilities })),
  }
}

export async function writeRateLimitManifest(
  rootDir: string,
  declarations: RateLimitDeclaration[],
  provider: RateLimitManifestProvider,
): Promise<void> {
  const manifest = createRateLimitManifest(declarations, provider)
  await writeFileIfChanged(resolve(rootDir, rateLimitManifestPath), `${JSON.stringify(manifest, null, 2)}\n`)
}
