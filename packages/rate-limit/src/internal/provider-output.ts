import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { createDefaultCloudflareOutputRoot, writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"

import { getCloudflareRateLimitBindingName } from "../integrations/cloudflare.ts"
import { normalizeRateLimitPolicy } from "../policy.ts"
import { writeRateLimitManifest } from "./manifest.ts"

import type { ProviderDeploymentOutputWriter } from "@vite-hub/internal/build/deployment-output"
import type { ProviderOutputConfigOwnership } from "@vite-hub/internal/build/provider-output-config"
import type { RateLimitDeclaration } from "../types.ts"

interface CloudflareRateLimitBindingConfig {
  [key: string]: unknown
  name: string
  namespace_id: string
  simple: {
    limit: number
    period: 10 | 60
  }
}

interface CloudflareRateLimitOutputState {
  bindings: string[]
  standalone: boolean
}

function outputStateFile(rootDir: string): string {
  return resolve(rootDir, ".vitehub", "rate-limit", "cloudflare-output.json")
}

async function readOutputState(rootDir: string): Promise<CloudflareRateLimitOutputState> {
  try {
    const parsed = JSON.parse(await readFile(outputStateFile(rootDir), "utf8")) as Partial<CloudflareRateLimitOutputState>
    return {
      bindings: Array.isArray(parsed.bindings)
        ? parsed.bindings.filter((value): value is string => typeof value === "string")
        : [],
      standalone: parsed.standalone !== false && Array.isArray(parsed.bindings) && parsed.bindings.length > 0,
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bindings: [], standalone: false }
    throw error
  }
}

async function writeOutputState(rootDir: string, bindings: string[], standalone = false): Promise<void> {
  const file = outputStateFile(rootDir)
  if (bindings.length === 0) {
    await rm(file, { force: true })
    return
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ bindings, standalone }, null, 2)}\n`, "utf8")
}

function namespaceId(namespace: string, rateLimitId: string): string {
  let hash = 2_166_136_261
  for (const character of `${namespace}:${rateLimitId}`) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16_777_619)
  }
  return String((hash >>> 0) || 1)
}

export function createCloudflareRateLimitBindings(
  declarations: RateLimitDeclaration[],
  namespace: string,
): CloudflareRateLimitBindingConfig[] {
  return declarations.map((declaration) => {
    const policy = normalizeRateLimitPolicy(declaration.policy)
    if (policy.enforcement === "strict") {
      throw new Error(`Rate Limit "${declaration.name}" requires strict enforcement, but Cloudflare's native Rate Limiting binding is best-effort.`)
    }
    const period = policy.windowMs / 1_000
    if (period !== 10 && period !== 60) {
      throw new Error(`Rate Limit "${declaration.name}" uses ${policy.window}, but Cloudflare Rate Limiting supports only 10s and 1m windows.`)
    }
    return {
      name: getCloudflareRateLimitBindingName(declaration.name),
      namespace_id: namespaceId(namespace, declaration.name),
      simple: { limit: policy.limit, period },
    }
  })
}

export function resolveRateLimitNamespace(configured?: string): string | undefined {
  return configured?.trim() || undefined
}

export async function writeRateLimitProviderOutput(options: {
  clientOutDir: string
  cloudflareOwnedByNitro?: boolean
  declarations: RateLimitDeclaration[]
  namespace?: string
  previousDeclarations?: RateLimitDeclaration[]
  provider: "cloudflare" | "memory"
  rootDir: string
}, write: ProviderDeploymentOutputWriter = writeProviderDeploymentOutputs): Promise<void> {
  const state = await readOutputState(options.rootDir)
  const currentBindings = options.declarations.map(declaration => getCloudflareRateLimitBindingName(declaration.name))
  const previousBindings = options.previousDeclarations?.map(declaration => getCloudflareRateLimitBindingName(declaration.name)) ?? []
  const ownership = {
    arrays: {
      ratelimits: {
        key: "name",
        values: [...new Set([...state.bindings, ...previousBindings, ...currentBindings])],
      },
    },
  } satisfies ProviderOutputConfigOwnership

  if (options.cloudflareOwnedByNitro) {
    if (options.provider === "cloudflare" && options.declarations.length > 0 && !options.namespace) {
      throw new Error("[vitehub] Cloudflare Rate Limit requires rateLimit.namespace to isolate counters between deployments.")
    }
    if (state.standalone && state.bindings.length > 0) {
      await write({
        clientOutDir: options.clientOutDir,
        cleanup: {
          cloudflare: {
            outputRoot: createDefaultCloudflareOutputRoot(options.rootDir),
            wranglerConfigOwnership: {
              arrays: {
                ratelimits: {
                  key: "name",
                  values: state.bindings,
                },
              },
            },
          },
        },
        rootDir: options.rootDir,
      })
    }
    await writeOutputState(options.rootDir, [])
    await writeRateLimitManifest(options.rootDir, options.declarations, options.provider)
    return
  }

  if (options.provider === "cloudflare" && options.declarations.length > 0) {
    if (!options.namespace) {
      throw new Error("[vitehub] Cloudflare Rate Limit requires rateLimit.namespace to isolate counters between deployments.")
    }
    await write({
      clientOutDir: options.clientOutDir,
      cloudflare: {
        outputRoot: createDefaultCloudflareOutputRoot(options.rootDir),
        wranglerConfig: {
          ratelimits: createCloudflareRateLimitBindings(options.declarations, options.namespace),
        },
        wranglerConfigOwnership: ownership,
      },
      rootDir: options.rootDir,
    })
    await writeOutputState(options.rootDir, currentBindings, true)
    await writeRateLimitManifest(options.rootDir, options.declarations, options.provider)
    return
  }

  await write({
    clientOutDir: options.clientOutDir,
    cleanup: {
      cloudflare: {
        outputRoot: createDefaultCloudflareOutputRoot(options.rootDir),
        wranglerConfigOwnership: ownership,
      },
    },
    rootDir: options.rootDir,
  })
  await writeOutputState(options.rootDir, [])
  await writeRateLimitManifest(options.rootDir, options.declarations, options.provider)
}
