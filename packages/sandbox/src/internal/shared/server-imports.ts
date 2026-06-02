import type { ScanDir } from 'unimport'
import type { ServerImport } from './runtime-artifacts'

export type ServerPresetImport = string | {
  name: string
  as?: string
  type?: boolean
}

export type ServerImportsPreset = {
  from: string
  imports: ServerPresetImport[]
}

export type ServerImportsOptions = false | {
  autoImport?: boolean
  dirs?: Array<string | ScanDir>
  presets?: unknown[]
} | undefined

export function isServerAutoImportEnabled(imports: ServerImportsOptions): boolean {
  return imports !== false && imports?.autoImport !== false
}

function getServerImportKey(entry: Pick<ServerImport, 'from' | 'name' | 'as' | 'type'>) {
  return [
    entry.from,
    entry.name,
    entry.as || '',
    entry.type ? 'type' : 'value',
  ].join(':')
}

function normalizePresetImport(from: string, entry: ServerPresetImport): ServerImport {
  if (typeof entry === 'string')
    return { from, name: entry }

  return {
    from,
    name: entry.name,
    ...(entry.as ? { as: entry.as } : {}),
    ...(entry.type ? { type: true } : {}),
  }
}

function isInlinePreset(value: unknown): value is {
  from: string
  imports: unknown[]
} {
  return !!value
    && typeof value === 'object'
    && typeof (value as { from?: unknown }).from === 'string'
    && Array.isArray((value as { imports?: unknown }).imports)
}

function isPresetImport(value: unknown): value is {
  name: string
  as?: string
  type?: boolean
} {
  return !!value
    && typeof value === 'object'
    && typeof (value as { name?: unknown }).name === 'string'
}

function collectPresetImports(from: string, entry: unknown, normalized: ServerImport[]) {
  if (typeof entry === 'string') {
    normalized.push(normalizePresetImport(from, entry))
    return
  }

  if (isInlinePreset(entry)) {
    for (const nested of entry.imports)
      collectPresetImports(entry.from, nested, normalized)
    return
  }

  if (isPresetImport(entry))
    normalized.push(normalizePresetImport(from, entry))
}

function toPresetImport(entry: ServerImport): ServerPresetImport {
  if (!entry.as && !entry.type)
    return entry.name

  return {
    name: entry.name,
    ...(entry.as ? { as: entry.as } : {}),
    ...(entry.type ? { type: true } : {}),
  }
}

export function dedupeServerImports(imports: readonly ServerImport[]): ServerImport[] {
  const seen = new Set<string>()
  const deduped: ServerImport[] = []

  for (const entry of imports) {
    const key = getServerImportKey(entry)
    if (seen.has(key))
      continue

    seen.add(key)
    deduped.push(entry)
  }

  return deduped
}

export function readServerImports(imports: ServerImportsOptions): ServerImport[] {
  if (typeof imports === 'undefined' || imports === false)
    return []

  const normalized: ServerImport[] = []

  for (const preset of imports.presets || []) {
    if (!isInlinePreset(preset))
      continue

    for (const entry of preset.imports)
      collectPresetImports(preset.from, entry, normalized)
  }

  return normalized
}

export function groupServerImportsIntoPresets(imports: readonly ServerImport[]): ServerImportsPreset[] {
  const grouped = new Map<string, ServerPresetImport[]>()

  for (const entry of imports) {
    const items = grouped.get(entry.from) || []
    items.push(toPresetImport(entry))
    grouped.set(entry.from, items)
  }

  return Array.from(grouped, ([from, entries]) => ({
    from,
    imports: entries,
  }))
}

export function mergeServerImports(
  imports: ServerImportsOptions,
  serverImports: readonly ServerImport[],
): ServerImportsOptions {
  if (serverImports.length === 0)
    return imports

  if (imports === false)
    return false

  if (!isServerAutoImportEnabled(imports))
    return imports

  const mergedImports = dedupeServerImports([
    ...readServerImports(imports),
    ...serverImports,
  ])

  return {
    ...imports,
    presets: groupServerImportsIntoPresets(mergedImports),
  }
}
