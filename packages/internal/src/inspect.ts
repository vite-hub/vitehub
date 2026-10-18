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

export interface ViteHubInspectionContributor {
  definitions?: readonly ViteHubDefinitionInspector[]
  providerOutput?: readonly ViteHubProviderOutputEntry[]
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
    if (entryKey && secretKeyPattern.test(entryKey)) return redactedInspectionValue
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
      if (entry instanceof Date) return Number.isNaN(entry.getTime()) ? "Invalid Date" : entry.toISOString()
      if (Array.isArray(entry)) return entry.slice(0, 100).map(item => visit(item, undefined, depth + 1))
      if (entry instanceof Set) return [...entry].slice(0, 100).map(item => visit(item, undefined, depth + 1))
      const entries = entry instanceof Map ? [...entry].map(([name, item]) => [String(name), item] as const) : Object.entries(entry)
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
