import { defu } from "defu"

import { isPlainObject } from "@vitehub/internal/object"

import type { ResolvedWorkflowOptions, WorkflowModuleOptions, WorkflowSharedOptions } from "./types.ts"

interface WorkflowResolutionInput {
  hosting?: string
}

const knownProviders = new Set(["cloudflare", "vercel"])

function normalizeHosting(hosting: string | undefined): string {
  return hosting?.trim().toLowerCase().replaceAll("_", "-") || ""
}

function resolveProvider(options: Record<string, unknown>, hosting: string): ResolvedWorkflowOptions {
  const shared: WorkflowSharedOptions = {
    ...(typeof options.binding === "string" ? { binding: options.binding } : {}),
    ...(typeof options.name === "string" ? { name: options.name } : {}),
  }
  const provider = options.provider

  if (typeof provider === "string" && !knownProviders.has(provider)) {
    throw new TypeError(`Unknown \`workflow.provider\`: ${JSON.stringify(provider)}. Expected "cloudflare" or "vercel".`)
  }

  const resolved = provider || (hosting.includes("cloudflare") ? "cloudflare" : "vercel")

  if (resolved === "cloudflare") {
    return defu(shared, { provider: "cloudflare" as const })
  }

  return defu(shared, { provider: "vercel" as const })
}

export function normalizeWorkflowOptions(options: WorkflowModuleOptions | undefined, input: WorkflowResolutionInput = {}): ResolvedWorkflowOptions | undefined {
  if (options === false) return undefined
  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw new TypeError("`workflow` must be a plain object.")
  }
  return resolveProvider(options || {}, normalizeHosting(input.hosting))
}
