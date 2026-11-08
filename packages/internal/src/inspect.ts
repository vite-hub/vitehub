import { relative } from "pathe"

export interface ViteHubDefinitionField {
  label: string
  value: string
}

/** Serializable summary of one discovered Definition. Files are relative to the project root. */
export interface ViteHubDefinitionSummary {
  fields: readonly ViteHubDefinitionField[]
  file: string
  name: string
  source: string
}

/** Lists the Definitions that one owner package discovered for the resolved Vite config. */
export interface ViteHubDefinitionInspector {
  /** Stable singular kind, for example `queue` or `rate-limit`. */
  kind: string
  label: string
  list: () => Promise<readonly ViteHubDefinitionSummary[]> | readonly ViteHubDefinitionSummary[]
}

/** One generated Provider Output file or directory that an owner package can write. */
export interface ViteHubProviderOutputEntry {
  description: string
  owner: string
  /** Absolute path. */
  path: string
}

/**
 * Where an inspected resource id came from. `name` means the host binds the resource by its name and needs no id.
 * The CLI sets `provider-output` when only a generated Wrangler config names the id.
 */
export type ViteHubResourceIdSource = "config" | "env" | "name" | "provider-output" | "provision-state"

/** One host resource that a Definition or store maps to. Owner packages read only local config and Provision State. */
export interface ViteHubResourceSummary {
  /** Cloudflare binding name, so the CLI can find the id in generated Wrangler config. */
  binding?: string
  /** Definition or store name. */
  definition: string
  /** Env variable that supplied the id when `source` is `env`. */
  env?: string
  host: "cloudflare" | "vercel"
  id?: string
  /** Same resource kind names as Provision actions, for example `cloudflare-d1`. */
  kind: string
  /** Resource name on the host, when the config names it. */
  name?: string
  /** Explains how the host finds the resource when no id or name is known locally. */
  note?: string
  owner: string
  /** Absent when no id is known yet. */
  source?: ViteHubResourceIdSource
}

export interface ViteHubInspectionContributor {
  definitions?: readonly ViteHubDefinitionInspector[]
  providerOutput?: readonly ViteHubProviderOutputEntry[]
  resources?: () => readonly ViteHubResourceSummary[] | Promise<readonly ViteHubResourceSummary[]>
}

export type ViteHubInspectionContributorFactory = () =>
  | ViteHubInspectionContributor
  | undefined
  | Promise<ViteHubInspectionContributor | undefined>

export interface ViteHubInspectionPluginMetadata {
  inspect?: ViteHubInspectionContributor | ViteHubInspectionContributorFactory
}

export interface ViteHubInspectionContributingPlugin {
  vitehub?: ViteHubInspectionPluginMetadata
}

async function collectContributors(plugins: readonly unknown[]): Promise<ViteHubInspectionContributor[]> {
  const contributors: ViteHubInspectionContributor[] = []
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== "object" || !Object.hasOwn(plugin, "vitehub")) continue
    const metadata = (plugin as ViteHubInspectionContributingPlugin).vitehub
    if (!metadata || typeof metadata !== "object" || !Object.hasOwn(metadata, "inspect")) continue
    const value = metadata.inspect
    const contributor = typeof value === "function" ? await value() : value
    if (contributor) contributors.push(contributor)
  }
  return contributors
}

/** Collects Definition inspectors from active plugins. A later plugin replaces an earlier inspector of the same kind. */
export async function collectViteHubDefinitionInspectors(plugins: readonly unknown[]): Promise<ViteHubDefinitionInspector[]> {
  const inspectors = new Map<string, ViteHubDefinitionInspector>()
  for (const contributor of await collectContributors(plugins)) {
    for (const inspector of contributor.definitions ?? []) inspectors.set(inspector.kind, inspector)
  }
  return [...inspectors.values()]
}

/** Collects Provider Output entries from active plugins, keyed by path. */
export async function collectViteHubProviderOutputEntries(plugins: readonly unknown[]): Promise<ViteHubProviderOutputEntry[]> {
  const entries = new Map<string, ViteHubProviderOutputEntry>()
  for (const contributor of await collectContributors(plugins)) {
    for (const entry of contributor.providerOutput ?? []) entries.set(entry.path, entry)
  }
  return [...entries.values()]
}

/** Collects host resources from active plugins in plugin order. */
export async function collectViteHubResourceSummaries(plugins: readonly unknown[]): Promise<ViteHubResourceSummary[]> {
  const resources: ViteHubResourceSummary[] = []
  for (const contributor of await collectContributors(plugins)) resources.push(...await contributor.resources?.() ?? [])
  return resources
}

export function relativeDefinitionFile(projectRoot: string, file: string): string {
  return relative(projectRoot, file).replaceAll("\\", "/")
}

/** Summarizes Definitions that have no owner-specific fields. */
export function summarizeDefinitions(
  projectRoot: string,
  definitions: readonly { handler: string, name: string, source?: string }[],
  fallbackSource: string,
): ViteHubDefinitionSummary[] {
  return definitions.map(definition => ({
    fields: [],
    file: relativeDefinitionFile(projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || fallbackSource,
  }))
}

export const redactedInspectionValue = "[redacted]"

const secretKeyPattern = /secret|token|passw(?:or)?d|credential|api[-_\s]?key|private[-_\s]?key|authorization|cookie|signature|dsn|connection[-_\s]?string/i
const secretValuePattern = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/\s?#]*@|bearer\s)/i

/** Whether an inspection field names a credential, regardless of its value. */
export function isSecretInspectionKey(key: string): boolean {
  return secretKeyPattern.test(key)
}

const embeddedUrlCredentialPattern = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/gi
const embeddedCookiePattern = /\b([\w-]*cookie[\w-]*["']?\s*[:=]\s*)(?:"(?:\\[^\r\n]|[^"\\\r\n])*"(?:\s*;\s*[\w.-]+\s*=[^;\r\n]*)*|'(?:\\[^\r\n]|[^'\\\r\n])*'(?:\s*;\s*[\w.-]+\s*=[^;\r\n]*)*|[^\r\n]+?(?=\s*(?:;\s*[^;=\r\n/]+\s*(?:\r?\n|$)|&|\r?\n|$)))/gi
const embeddedBearerPattern = /\bbearer\s+[^\s,;]+/gi
const embeddedAuthorizationPattern = new RegExp(
  String.raw`\b([\w-]*authorization[\w-]*["']?\s*[:=]\s*)(?!\[redacted\](?=$|[\s,;}&]))(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'|[^\r\n]+?(?=\s*(?:[,;])?\s*(?:${secretKeyPattern.source})[\w-]*\s*[:=]|\s+rejected\b|$))`,
  "gi",
)

const embeddedSecretAssignmentPattern = new RegExp(
  String.raw`\b([\w-]*(?:${secretKeyPattern.source})[\w-]*["']?\s*[:=]\s*)(?!\[redacted\](?=$|[\s,;}&]))(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'|[^\s,;&#&]+)`,
  "gi",
)

/**
 * Removes credentials inside free text, for example an error message. URL credentials, bearer tokens, and
 * `name=value` pairs with a secret name are replaced with `[redacted]`.
 */
export function redactInspectionText(value: string): string {
  return value
    .replace(embeddedUrlCredentialPattern, `$1${redactedInspectionValue}@`)
    .replace(embeddedAuthorizationPattern, `$1${redactedInspectionValue}`)
    .replace(embeddedCookiePattern, `$1${redactedInspectionValue}`)
    .replace(embeddedBearerPattern, `Bearer ${redactedInspectionValue}`)
    .replace(embeddedSecretAssignmentPattern, `$1${redactedInspectionValue}`)
}

/**
 * Removes values that can carry credentials before inspection output leaves the process.
 * Keys that name secrets, plaintext Worker `vars`, and URLs with embedded credentials are redacted.
 */
export function redactInspectionValue(value: unknown, key?: string): unknown {
  const seen = new WeakSet<object>()
  let remaining = 1000
  function visit(entry: unknown, entryKey?: string, depth = 0): unknown {
    if (entryKey && isSecretInspectionKey(entryKey)) return redactedInspectionValue
    if (--remaining < 0 || depth > 10) return "[truncated]"
    if (typeof entry === "string") {
      const text = entry.slice(0, 10_000)
      return secretValuePattern.test(text) ? redactedInspectionValue : redactInspectionText(text)
    }
    if (typeof entry === "bigint") return entry.toString()
    if (typeof entry === "number") return Number.isFinite(entry) ? entry : String(entry)
    if (entry === null || typeof entry === "boolean") return entry
    if (typeof entry !== "object") return entry === undefined ? null : "[unsupported]"
    if (seen.has(entry)) return "[circular]"
    seen.add(entry)
    try {
      let dateTime: number | undefined
      try {
        dateTime = Date.prototype.getTime.call(entry)
      }
      catch {
        // The Date intrinsic rejects values that are not Dates, including cross-realm impostors.
      }
      if (dateTime !== undefined) return Number.isNaN(dateTime) ? "Invalid Date" : Date.prototype.toISOString.call(entry)
      if (Array.isArray(entry)) return entry.slice(0, 100).map(item => visit(item, undefined, depth + 1))
      let setValues: unknown[] | undefined
      try {
        setValues = [...Set.prototype.values.call(entry)]
      }
      catch {
        // The Set intrinsic rejects values that are not Sets, including cross-realm impostors.
      }
      if (setValues) return setValues.slice(0, 100).map(item => visit(item, undefined, depth + 1))
      let mapEntries: [unknown, unknown][] | undefined
      try {
        mapEntries = [...Map.prototype.entries.call(entry)]
      }
      catch {
        // The Map intrinsic rejects values that are not Maps, including cross-realm impostors.
      }
      const entries = mapEntries ? mapEntries.map(([name, item]) => [String(name), item] as const) : Object.entries(entry)
      return Object.fromEntries(entries.slice(0, 100).map(([name, item]) => [
        name,
        name === "vars" && item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.keys(item).slice(0, 100).map(variable => [variable, redactedInspectionValue]))
          : visit(item, name, depth + 1),
      ]))
    }
    finally {
      seen.delete(entry)
    }
  }
  return visit(value, key)
}
