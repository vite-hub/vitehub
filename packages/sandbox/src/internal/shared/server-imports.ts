import type { ScanDir } from 'unimport'
import type { ServerImport } from './runtime-artifacts'

export type NitroPresetImport = string | {
  name: string
  as?: string
  type?: boolean
}

export type NitroImportsPreset = {
  from: string
  imports: NitroPresetImport[]
}

export type NitroImportsOptions = false | {
  autoImport?: boolean
  dirs?: Array<string | ScanDir>
  presets?: unknown[]
} | undefined

export function isNitroAutoImportEnabled(imports: NitroImportsOptions): boolean {
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

function normalizePresetImport(from: string, entry: NitroPresetImport): ServerImport {
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

function toPresetImport(entry: ServerImport): NitroPresetImport {
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

export function readNitroServerImports(imports: NitroImportsOptions): ServerImport[] {
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

export function groupServerImportsIntoNitroPresets(imports: readonly ServerImport[]): NitroImportsPreset[] {
  const grouped = new Map<string, NitroPresetImport[]>()

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

export function mergeNitroImportsWithServerImports(
  imports: NitroImportsOptions,
  serverImports: readonly ServerImport[],
): NitroImportsOptions {
  if (serverImports.length === 0)
    return imports

  if (imports === false)
    return false

  if (!isNitroAutoImportEnabled(imports))
    return imports

  const mergedImports = dedupeServerImports([
    ...readNitroServerImports(imports),
    ...serverImports,
  ])

  return {
    ...(imports ?? {}),
    presets: groupServerImportsIntoNitroPresets(mergedImports),
  }
}

export function applyServerImportsToNitro(
  target: { imports?: NitroImportsOptions },
  serverImports: readonly ServerImport[],
): NitroImportsOptions {
  if (serverImports.length === 0)
    return target.imports

  if (target.imports === false)
    return false

  if (!isNitroAutoImportEnabled(target.imports))
    return target.imports

  target.imports = mergeNitroImportsWithServerImports(target.imports, serverImports)
  return target.imports
}
