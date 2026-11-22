import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { collectViteHubResourceSummaries } from "@vite-hub/internal/inspect"

import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubResourceSummary } from "@vite-hub/internal/inspect"

type WranglerEntries = Record<string, unknown>[]

function entries(value: unknown): WranglerEntries {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : []
}

function section(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key]
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const wranglerFields: Record<string, { entries: (config: Record<string, unknown>) => WranglerEntries, binding: string, name?: string }> = {
  "cloudflare-d1": { binding: "binding", entries: config => entries(config.d1_databases) },
  "cloudflare-durable-object": { binding: "name", entries: config => entries(section(config, "durable_objects").bindings), name: "class_name" },
  "cloudflare-kv-namespace": { binding: "binding", entries: config => entries(config.kv_namespaces) },
  "cloudflare-queue": { binding: "binding", entries: config => entries(section(config, "queues").producers), name: "queue" },
  "cloudflare-r2-bucket": { binding: "binding", entries: config => entries(config.r2_buckets) },
  "cloudflare-workflow": { binding: "binding", entries: config => entries(config.workflows), name: "name" },
}

function describe(resource: ViteHubResourceSummary): string {
  const owner = `for ${resource.owner} "${resource.definition}"`
  if (resource.kind === "cloudflare-cron") return `the cron trigger "${resource.name}" ${owner}`
  return `the ${resource.kind} binding ${resource.binding}${resource.name ? ` (${resource.name})` : ""} ${owner}`
}

/**
 * Lists the resources that the Wrangler config lacks. A resource without a binding or cron is not checked, and neither is
 * one in a standalone Worker's own Wrangler config.
 */
export function findMissingCloudflareResources(config: Record<string, unknown>, resources: readonly ViteHubResourceSummary[]): ViteHubResourceSummary[] {
  const triggers = section(config, "triggers")
  const crons = new Set(Array.isArray(triggers.crons) ? triggers.crons.filter(cron => typeof cron === "string") : [])
  return resources.filter((resource) => {
    if (resource.host !== "cloudflare" || resource.standalone) return false
    if (resource.kind === "cloudflare-cron") return resource.name !== undefined && !crons.has(resource.name)
    const fields = wranglerFields[resource.kind]
    if (!fields || !resource.binding) return false
    return !fields.entries(config).some(entry =>
      entry[fields.binding] === resource.binding
      && (!fields.name || resource.name === undefined || entry[fields.name] === resource.name))
  })
}

const realtimeDurableObject: ViteHubResourceSummary = { binding: "$DurableObject", definition: "rooms", host: "cloudflare", kind: "cloudflare-durable-object", name: "$DurableObject", owner: "realtime" }

/**
 * Checks the final `wrangler.json` against the resources that the ViteHub plugins list for this build, and throws when one
 * is missing. A Worker deployed without a binding fails only when code first reads it. A missing or invalid file lacks
 * every resource.
 */
export async function assertCloudflareResources(serverDir: string, plugins: readonly unknown[], options: { realtime?: boolean } = {}): Promise<void> {
  const file = join(serverDir, "wrangler.json")
  let config: unknown
  if (existsSync(file)) {
    const contents = await readFile(file, "utf8")
    try {
      config = JSON.parse(contents)
    }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  const resources = [...await collectViteHubResourceSummaries(plugins), ...options.realtime ? [realtimeDurableObject] : []]
  const missing = findMissingCloudflareResources(typeof config === "object" && config !== null && !Array.isArray(config) ? config as Record<string, unknown> : {}, resources)
  if (missing.length) throw viteHubErrorDiagnostics.VITE_HUB_CLOUDFLARE_RESOURCE_MISSING({ file, resources: missing.map(describe).join("; ") })
}
