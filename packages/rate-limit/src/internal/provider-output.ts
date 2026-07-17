import { readFileSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename } from "node:path"
import { dirname, resolve } from "node:path"

import { createDefaultCloudflareOutputRoot, writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"

import { getCloudflareRateLimitBindingName } from "../integrations/cloudflare.ts"
import { normalizeRateLimitPolicy } from "../policy.ts"
import { writeRateLimitManifest } from "./manifest.ts"

import type { DiscoveredRateLimitDefinition, RateLimitDefinition } from "../types.ts"
import type { ProviderOutputConfigOwnership } from "@vite-hub/internal/build/provider-output-config"

interface CloudflareRateLimitBindingConfig {
  name: string
  namespace_id: string
  simple: {
    limit: number
    period: 10 | 60
  }
}

interface CloudflareRateLimitOutputState {
  bindings: string[]
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
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bindings: [] }
    throw error
  }
}

async function writeOutputState(rootDir: string, bindings: string[]): Promise<void> {
  const file = outputStateFile(rootDir)
  if (bindings.length === 0) {
    await rm(file, { force: true })
    return
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ bindings }, null, 2)}\n`, "utf8")
}

function readDefinitionObject(source: string, name: string): string {
  const match = /\bexport\s+default\s+defineRateLimit\s*\(/g.exec(source)
  if (!match) {
    throw new Error(`Rate Limit Definition "${name}" must default-export defineRateLimit({ ... }) for Provider Output.`)
  }
  const open = source.indexOf("{", match.index + match[0].length)
  if (open === -1) {
    throw new Error(`Rate Limit Definition "${name}" must default-export defineRateLimit({ ... }) for Provider Output.`)
  }
  let quote: string | undefined
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]!
    if (quote) {
      if (character === "\\") index += 1
      else if (character === quote) quote = undefined
      continue
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character
      continue
    }
    if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index + 2)
      if (index === -1) break
      continue
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2)
      if (close === -1) break
      index = close + 1
      continue
    }
    if (depth === 1 && source.startsWith("...", index)) {
      throw new Error(`Rate Limit Definition "${name}" cannot use object spreads in a policy used for Provider Output.`)
    }
    if (character === "{") depth += 1
    if (character === "}" && --depth === 0) return source.slice(open, index + 1)
  }
  throw new Error(`Rate Limit Definition "${name}" must default-export a complete defineRateLimit({ ... }) object.`)
}

function readStaticProperty(source: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[,\\n\\r{])\\s*${name}\\s*:\\s*([^,}\\n\\r]+)`, "m").exec(source)
  return match?.[1]?.trim()
}

function readStaticString(source: string, name: string): string | undefined {
  const value = readStaticProperty(source, name)
  if (!value) return
  const match = /^(["'`])([^"'`]*)\1$/.exec(value)
  return match?.[2]
}

function readRateLimitDefinition(file: string, name: string): RateLimitDefinition {
  const source = readDefinitionObject(readFileSync(file, "utf8"), name)
  const limitValue = readStaticProperty(source, "limit")
  const limit = limitValue && /^\d+$/.test(limitValue) ? Number(limitValue) : undefined
  const window = readStaticString(source, "window")
  const enforcement = readStaticString(source, "enforcement")
  const failure = readStaticString(source, "failure")
  if (limit === undefined || window === undefined) {
    throw new Error(`Rate Limit Definition "${name}" must declare static limit and window values for Provider Output.`)
  }
  return {
    ...(enforcement ? { enforcement: enforcement as RateLimitDefinition["enforcement"] } : {}),
    ...(failure ? { failure: failure as RateLimitDefinition["failure"] } : {}),
    limit,
    window: window as RateLimitDefinition["window"],
  }
}

function namespaceId(projectName: string, definitionName: string): string {
  let hash = 2_166_136_261
  for (const character of `${projectName}:${definitionName}`) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16_777_619)
  }
  return String((hash >>> 0) || 1)
}

export function createCloudflareRateLimitBindings(
  definitions: DiscoveredRateLimitDefinition[],
  rootDir: string,
): CloudflareRateLimitBindingConfig[] {
  const projectName = basename(rootDir)
  return definitions.map((discovered) => {
    const definition = normalizeRateLimitPolicy(readRateLimitDefinition(discovered.handler, discovered.name))
    if (definition.enforcement === "strict") {
      throw new Error(`Rate Limit Definition "${discovered.name}" requires strict enforcement, but Cloudflare's native Rate Limiting binding is best-effort.`)
    }
    const period = definition.windowMs / 1_000
    if (period !== 10 && period !== 60) {
      throw new Error(`Rate Limit Definition "${discovered.name}" uses ${definition.window}, but Cloudflare Rate Limiting supports only 10s and 1m windows.`)
    }
    return {
      name: getCloudflareRateLimitBindingName(discovered.name),
      namespace_id: namespaceId(projectName, discovered.name),
      simple: { limit: definition.limit, period },
    }
  })
}

export async function writeRateLimitProviderOutput(options: {
  clientOutDir: string
  definitions: DiscoveredRateLimitDefinition[]
  previousDefinitions?: DiscoveredRateLimitDefinition[]
  provider: "cloudflare" | "memory"
  rootDir: string
}): Promise<void> {
  const state = await readOutputState(options.rootDir)
  const currentBindings = options.definitions.map(definition => getCloudflareRateLimitBindingName(definition.name))
  const previousBindings = options.previousDefinitions?.map(definition => getCloudflareRateLimitBindingName(definition.name)) ?? []
  const ownership = {
    arrays: {
      ratelimits: {
        key: "name",
        values: [...new Set([...state.bindings, ...previousBindings, ...currentBindings])],
      },
    },
  } satisfies ProviderOutputConfigOwnership

  if (options.provider === "cloudflare" && options.definitions.length > 0) {
    await writeProviderDeploymentOutputs({
      clientOutDir: options.clientOutDir,
      cloudflare: {
        outputRoot: createDefaultCloudflareOutputRoot(options.rootDir),
        wranglerConfig: {
          ratelimits: createCloudflareRateLimitBindings(options.definitions, options.rootDir),
        },
        wranglerConfigOwnership: ownership,
      },
      rootDir: options.rootDir,
    })
    await writeOutputState(options.rootDir, currentBindings)
    await writeRateLimitManifest(options.rootDir, options.definitions, options.provider)
    return
  }

  await writeProviderDeploymentOutputs({
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
  await writeRateLimitManifest(options.rootDir, options.definitions, options.provider)
}
