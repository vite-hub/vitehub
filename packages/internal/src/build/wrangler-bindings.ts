import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { isPlainObject } from "../object.ts"
import { internalErrorDiagnostics } from "../error-diagnostics.ts"

/** One named-entry array in Wrangler config, such as `kv_namespaces`, and how two entries of one name merge. */
export interface WranglerEntrySpec {
  /** The path of the array, such as `["durable_objects", "bindings"]`. */
  path: readonly string[]
  /** The field that names an entry. */
  identity: string
  /** Fields that select the resource. Two entries of one name must agree on them. */
  resource: readonly string[]
  /** Resource fields that hold an id. An all-zero id stands for a resource that does not exist yet. */
  ids?: readonly string[]
  /** Keep unresolved placeholder IDs for resources that Wrangler cannot provision automatically. */
  preservePlaceholderIds?: boolean
  /** Mutually exclusive resource fields. Duplicate entries cannot select different fields in one group. */
  exclusive?: readonly (readonly string[])[]
  /** Fields that the first entry keeps together: when it sets one of them, later entries fill none of them. */
  groups?: readonly (readonly string[])[]
}

export interface WranglerEntryConflict {
  field: string
  generated: unknown
  name: string
  path: string
  project: unknown
  /** The Wrangler environment, such as ` in env.production`, or an empty string at the top level. */
  scope: string
}

/**
 * Named-entry arrays that ViteHub writes, other than `d1_databases`, which the Database package collapses with its
 * own rules and error.
 */
export const wranglerEntrySpecs: readonly WranglerEntrySpec[] = [
  { path: ["kv_namespaces"], identity: "binding", resource: ["id", "preview_id"], ids: ["id", "preview_id"] },
  { path: ["r2_buckets"], identity: "binding", resource: ["bucket_name", "jurisdiction", "preview_bucket_name"] },
  { path: ["ratelimits"], identity: "name", resource: ["namespace_id", "simple"] },
  { path: ["hyperdrive"], identity: "binding", resource: ["id"], ids: ["id"], preservePlaceholderIds: true },
  { path: ["containers"], identity: "class_name", resource: ["image", "image_build_context", "name", "instance_type", "max_instances"] },
  { path: ["durable_objects", "bindings"], identity: "name", resource: ["class_name", "script_name", "environment"] },
  { path: ["migrations"], identity: "tag", resource: ["new_classes", "new_sqlite_classes", "renamed_classes", "deleted_classes", "transferred_classes"] },
  { path: ["queues", "producers"], identity: "binding", resource: ["queue"] },
  { path: ["queues", "consumers"], identity: "queue", resource: [] },
  { path: ["workflows"], identity: "binding", resource: ["name", "class_name", "script_name", "jurisdiction"], exclusive: [["script_name", "jurisdiction"]] },
  { path: ["services"], identity: "binding", resource: ["service", "entrypoint"] },
  { path: ["send_email"], identity: "name", resource: ["destination_address", "allowed_destination_addresses", "allowed_sender_addresses"], exclusive: [["destination_address", "allowed_destination_addresses"]] },
  { path: ["analytics_engine_datasets"], identity: "binding", resource: ["dataset"] },
]

/** Zeros only, or a UUID that is zero apart from its version and variant digits. */
const placeholderId = /^(?:0+|0{8}-0{4}-[0-8]000-[089ab]000-0{12})$/

/**
 * Whether `value` is an all-zero id, such as `00000000000000000000000000000000` or
 * `00000000-0000-4000-8000-000000000000`. Templates such as a Deploy to Cloudflare repository put one where Cloudflare
 * writes the real id. It never names a resource.
 */
export function isPlaceholderCloudflareId(value: unknown): boolean {
  return typeof value === "string" && placeholderId.test(value)
}

function defaultConflict({ field, generated, name, path, project, scope }: WranglerEntryConflict): Error {
  return internalErrorDiagnostics.INTERNAL_B0051({ field, generated: JSON.stringify(generated), name, path, project: JSON.stringify(project), scope })
}

/**
 * One entry per name. Nitro's Cloudflare preset concatenates the generated arrays with the project's wrangler config,
 * so the generated entry comes first. It wins, and later entries only fill fields it lacks. A real id replaces an
 * all-zero one, and an id that stays all-zero is left out when Wrangler can provision the resource automatically.
 */
function collapseEntries(entries: readonly unknown[], spec: WranglerEntrySpec, scope: string, conflict: (details: WranglerEntryConflict) => Error): unknown[] {
  const collapsed: unknown[] = []
  const byName = new Map<string, Record<string, unknown>>()
  for (const entry of entries) {
    if (!isPlainObject(entry) || typeof entry[spec.identity] !== "string") {
      collapsed.push(entry)
      continue
    }
    const name = entry[spec.identity] as string
    const first = byName.get(name)
    if (!first) {
      const copy: Record<string, unknown> = { ...entry }
      byName.set(name, copy)
      collapsed.push(copy)
      continue
    }
    for (const group of spec.exclusive ?? []) {
      const generatedField = group.find(field => first[field] !== undefined)
      const projectField = group.find(field => entry[field] !== undefined)
      if (generatedField && projectField && generatedField !== projectField) {
        throw conflict({ field: group.join(" / "), generated: { [generatedField]: first[generatedField] }, name, path: spec.path.join("."), project: { [projectField]: entry[projectField] }, scope })
      }
    }
    for (const field of spec.resource) {
      const generated = first[field]
      const project = entry[field]
      if (generated === undefined || project === undefined || isDeepStrictEqual(generated, project)) continue
      const isId = spec.ids?.includes(field) === true
      if (isId && isPlaceholderCloudflareId(project)) continue
      if (isId && isPlaceholderCloudflareId(generated)) {
        first[field] = project
        continue
      }
      throw conflict({ field, generated, name, path: spec.path.join("."), project, scope })
    }
    const kept = new Set((spec.groups ?? []).filter(group => group.some(field => first[field] !== undefined)).flat())
    for (const [key, value] of Object.entries(entry)) {
      if (!kept.has(key) && first[key] === undefined) first[key] = value
    }
  }
  for (const entry of byName.values()) {
    for (const field of spec.ids ?? []) {
      if (!spec.preservePlaceholderIds && isPlaceholderCloudflareId(entry[field])) delete entry[field]
    }
  }
  return collapsed
}

function unique(values: unknown): unknown {
  return Array.isArray(values) ? [...new Set(values)] : values
}

function collapseTarget(target: Record<string, unknown>, specs: readonly WranglerEntrySpec[], scope: string, conflict: (details: WranglerEntryConflict) => Error): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target }
  for (const spec of specs) {
    const parents = spec.path.slice(0, -1)
    const key = spec.path.at(-1)!
    let parent = result
    let found = true
    for (const segment of parents) {
      const next = parent[segment]
      if (!isPlainObject(next)) {
        found = false
        break
      }
      parent = parent[segment] = { ...next }
    }
    if (found && Array.isArray(parent[key])) parent[key] = collapseEntries(parent[key], spec, scope, conflict)
  }
  if (Array.isArray(result.compatibility_flags)) result.compatibility_flags = unique(result.compatibility_flags)
  if (isPlainObject(result.secrets) && Array.isArray(result.secrets.required)) {
    result.secrets = { ...result.secrets, required: unique(result.secrets.required) }
  }
  return result
}

export interface CollapseWranglerConfigOptions {
  /** Builds the error for two entries of one name that select different resources. */
  conflict?: (details: WranglerEntryConflict) => Error
  /** The arrays to collapse. Defaults to `wranglerEntrySpecs`. */
  specs?: readonly WranglerEntrySpec[]
}

/**
 * The Wrangler config with one entry per name in each array of `specs`, and without repeated compatibility flags or
 * required secrets, at the top level and in each `env`.
 */
export function collapseWranglerConfig(wrangler: Record<string, unknown>, options: CollapseWranglerConfigOptions = {}): Record<string, unknown> {
  const specs = options.specs ?? wranglerEntrySpecs
  const conflict = options.conflict ?? defaultConflict
  const result = collapseTarget(wrangler, specs, "", conflict)
  if (isPlainObject(wrangler.env)) {
    result.env = Object.fromEntries(Object.entries(wrangler.env).map(([name, config]) => [
      name,
      isPlainObject(config) ? collapseTarget(config, specs, ` in env.${name}`, conflict) : config,
    ]))
  }
  return result
}

/**
 * Collapses the `wrangler.json` in `serverDir` that Nitro's Cloudflare preset wrote. Run it in a `compiled` hook. It
 * does nothing when the file is missing, and writes only when something changed.
 */
export async function collapseWranglerConfigFile(serverDir: string, options: CollapseWranglerConfigOptions = {}): Promise<void> {
  const file = resolve(serverDir, "wrangler.json")
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return
  const wrangler: unknown = JSON.parse(text)
  if (!isPlainObject(wrangler)) return
  const collapsed = collapseWranglerConfig(wrangler, options)
  if (!isDeepStrictEqual(collapsed, wrangler)) await writeFile(file, `${JSON.stringify(collapsed, null, 2)}\n`)
}
