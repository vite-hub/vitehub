import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { FileEdit, FollowUp } from "../types.ts"
import type { FeatureBindings, HubFeatures } from "./config.ts"

const wranglerFiles = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]

export function findWranglerFile(cwd: string): string | undefined {
  return wranglerFiles.find(name => existsSync(join(cwd, name)))
}

type ResourceKind = "d1_databases" | "kv_namespaces" | "r2_buckets"

/** One binding entry of a Wrangler config, with its string fields. */
interface Resource {
  kind: ResourceKind
  fields: Record<string, string>
  line?: number
}

function lineAt(code: string, index: number): number {
  return code.slice(0, index).split("\n").length
}

/** Removes comments and trailing commas from JSONC, outside strings. */
function stripJsonc(code: string): string {
  let output = ""
  for (let index = 0; index < code.length; index++) {
    const char = code[index]
    if (char === "\"") {
      let to = index + 1
      while (to < code.length && code[to] !== "\"") to += code[to] === "\\" ? 2 : 1
      output += code.slice(index, to + 1)
      index = to
    }
    else if (char === "/" && code[index + 1] === "/") {
      while (index < code.length && code[index] !== "\n") index++
      output += "\n"
    }
    else if (char === "/" && code[index + 1] === "*") {
      const close = code.indexOf("*/", index + 2)
      index = close < 0 ? code.length : close + 1
    }
    else {
      output += char
    }
  }
  return output.replace(/,(\s*[}\]])/g, "$1")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function bindingLine(code: string, binding: string, toml: boolean): number | undefined {
  const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(toml ? `binding\\s*=\\s*["']${escaped}["']` : `"binding"\\s*:\\s*"${escaped}"`).exec(code)
  return match ? lineAt(code, match.index) : undefined
}

function readJsonResources(code: string): Resource[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonc(code))
  }
  catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const resources: Resource[] = []
  for (const kind of ["d1_databases", "kv_namespaces", "r2_buckets"] as const) {
    const entries = parsed[kind]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!isRecord(entry)) continue
      const fields = Object.fromEntries(Object.entries(entry).filter((field): field is [string, string] => typeof field[1] === "string"))
      resources.push({ kind, fields, line: fields.binding ? bindingLine(code, fields.binding, false) : undefined })
    }
  }
  return resources
}

/** Reads `[[d1_databases]]`, `[[kv_namespaces]]`, and `[[r2_buckets]]` tables with plain `key = "value"` lines. */
function readTomlResources(code: string): Resource[] {
  const resources: Resource[] = []
  let current: Resource | undefined
  for (const text of code.split("\n")) {
    const table = /^\s*\[\[\s*([\w.]+)\s*\]\]/.exec(text)
    if (table) {
      const kind = table[1]
      current = kind === "d1_databases" || kind === "kv_namespaces" || kind === "r2_buckets" ? { kind, fields: {} } : undefined
      if (current) resources.push(current)
      continue
    }
    if (/^\s*\[/.test(text)) {
      current = undefined
      continue
    }
    const field = /^\s*(\w+)\s*=\s*["']([^"']*)["']/.exec(text)
    if (current && field?.[1] && field[2] !== undefined) current.fields[field[1]] = field[2]
  }
  for (const resource of resources) resource.line = resource.fields.binding ? bindingLine(code, resource.fields.binding, true) : undefined
  return resources
}

/** ViteHub options that keep using the Cloudflare KV namespaces and R2 bucket of a Wrangler config. */
export type CloudflareResourceOptions = Partial<Record<"kv" | "cache" | "blob", Record<string, string>>>

/** A template's all-zero ID names no resource. */
const placeholderId = /^[0-]+$/

/** Reads the KV namespace IDs and the R2 bucket name that the ViteHub options need to keep the existing resources. */
export async function readCloudflareResourceOptions(cwd: string, file: string | undefined, bindings: FeatureBindings): Promise<CloudflareResourceOptions> {
  if (!file) return {}
  const code = await readFile(join(cwd, file), "utf8")
  const options: CloudflareResourceOptions = {}
  for (const { kind, fields } of (file.endsWith(".toml") ? readTomlResources(code) : readJsonResources(code)) ?? []) {
    const { binding, id, bucket_name: bucketName, jurisdiction } = fields
    if (!binding) continue
    for (const feature of ["kv", "cache"] as const) {
      if (kind === "kv_namespaces" && binding === bindings[feature] && id && !placeholderId.test(id)) options[feature] = { driver: "cloudflare-kv-binding", binding, namespaceId: id }
    }
    if (kind === "r2_buckets" && binding === bindings.blob && bucketName) options.blob = { driver: "cloudflare-r2", binding, bucketName, ...(jurisdiction ? { jurisdiction } : {}) }
  }
  return options
}

/** Removes `migrations_table: "_hub_migrations"` from a JSON or JSONC Wrangler config. */
function removeJsonMigrationsTable(code: string): string {
  let output = code
  for (let match = /"migrations_table"\s*:\s*"_hub_migrations"/.exec(output); match; match = /"migrations_table"\s*:\s*"_hub_migrations"/.exec(output)) {
    let from = match.index
    let to = from + match[0].length
    const after = /^[ \t]*,/.exec(output.slice(to))
    if (after) {
      to += after[0].length
    }
    else {
      // The last property: remove the comma before it.
      let before = from
      while (before > 0 && /\s/.test(output[before - 1] ?? "")) before--
      if (output[before - 1] === ",") from = before - 1
    }
    const lineStart = output.lastIndexOf("\n", from - 1) + 1
    const rest = /^[ \t]*\r?\n/.exec(output.slice(to))
    if (/^[ \t]*$/.test(output.slice(lineStart, from)) && rest) {
      from = lineStart
      to += rest[0].length
    }
    output = output.slice(0, from) + output.slice(to)
  }
  return output
}

export interface WranglerResult {
  edit?: FileEdit
  followUps: FollowUp[]
  /** The config binds a D1 database that the app keeps using. */
  d1: boolean
}

/** Plans the Wrangler config changes: the NuxtHub migrations table goes, and each binding that ViteHub now writes becomes a follow-up. */
export async function planWrangler(cwd: string, file: string | undefined, features: HubFeatures, cloudflare: boolean, bindings: FeatureBindings, written: CloudflareResourceOptions = {}): Promise<WranglerResult> {
  if (!file) return { followUps: [], d1: false }
  const code = await readFile(join(cwd, file), "utf8")
  const toml = file.endsWith(".toml")
  const followUps: FollowUp[] = []
  const tableLine = /migrations_table["']?\s*[:=]\s*["']_hub_migrations["']/.exec(code)
  const after = toml ? code.replace(/^[ \t]*migrations_table\s*=\s*["']_hub_migrations["'][ \t]*(?:#.*)?\r?\n/gm, "") : removeJsonMigrationsTable(code)
  if (tableLine && after !== code) {
    followUps.push({ file, line: lineAt(code, tableLine.index), message: "The codemod removed migrations_table: \"_hub_migrations\". NuxtHub and Wrangler record migrations differently, so ViteHub must not reuse that table. Baseline the database instead (see the database follow-ups)." })
  }
  const resources = toml ? readTomlResources(code) : readJsonResources(code)
  if (!resources) {
    followUps.push({ file, message: `The codemod cannot read ${file}. ViteHub writes the D1, KV, and R2 bindings itself. Set the IDs of the existing resources in ViteHub options, then remove those bindings from ${file}.` })
  }
  let d1 = false
  for (const resource of cloudflare ? resources ?? [] : []) {
    const { binding, database_id: databaseId, database_name: databaseName, id, bucket_name: bucketName, jurisdiction } = resource.fields
    const keep = `ViteHub writes the ${binding} binding itself, and a binding name alone can point at a new empty resource.`
    const remove = `Then remove this entry from ${file}.`
    if (resource.kind === "d1_databases" && features.database && binding && binding === bindings.database) {
      d1 = true
      const fields = [`binding: "${binding}"`, ...(databaseId ? [`databaseId: "${databaseId}"`] : []), `databaseName: "${databaseName ?? "<D1 database name>"}"`]
      followUps.push({ file, line: resource.line, message: `${keep} To keep this D1 database, set cloudflare: { ${fields.join(", ")} } in defineDatabase() in server/databases/default/index.ts. ViteHub writes migrations_dir for server/databases/default/migrations. ${remove}` })
    }
    for (const key of ["kv", "cache", "blob"] as const) {
      if (!features[key] || !binding || binding !== bindings[key] || resource.kind !== (key === "blob" ? "r2_buckets" : "kv_namespaces")) continue
      if (written[key]?.binding === binding) {
        followUps.push({ file, line: resource.line, message: `The codemod set vitehub.${key} to keep this ${key === "blob" ? "bucket" : "namespace"}, and ViteHub writes the ${binding} binding itself. Remove this entry from ${file}.` })
      }
      else if (key === "blob") {
        followUps.push({ file, line: resource.line, message: `${keep} To keep this bucket, set vitehub.blob to { driver: "cloudflare-r2", binding: "${binding}"${bucketName ? `, bucketName: "${bucketName}"` : ""}${jurisdiction ? `, jurisdiction: "${jurisdiction}"` : ""} } in nuxt.config. ${remove}` })
      }
      else {
        followUps.push({ file, line: resource.line, message: `${keep} ${key === "cache" ? "On Cloudflare, cache: true needs a namespace ID. " : ""}To keep this namespace, set vitehub.${key} to { driver: "cloudflare-kv-binding", binding: "${binding}"${id ? `, namespaceId: "${id}"` : ""} } in nuxt.config. ${remove}` })
      }
    }
  }
  return { edit: after === code ? undefined : { path: file, before: code, after }, followUps, d1 }
}
