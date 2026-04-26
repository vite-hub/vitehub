import { resolveModulePath } from "exsolve"

export function resolveRuntimeEntry(
  srcRelative: string,
  packageSubpath: string,
  importMetaUrl: string,
): string {
  const fromSource = resolveModulePath(srcRelative, {
    extensions: [".ts", ".mts"],
    from: importMetaUrl,
    try: true,
  })
  return fromSource ?? resolveModulePath(packageSubpath, {
    extensions: [".js", ".mjs"],
    from: importMetaUrl,
  })
}

export interface NitroImportPreset { from?: string, imports?: string[] }
export interface NitroImportsLike { presets?: unknown[] }

export function mergeNitroImportsPreset<T extends NitroImportsLike | false | undefined>(
  current: T,
  preset: { from: string, imports: string[] },
): T extends false ? false : NitroImportsLike {
  if (current === false) {
    return current as never
  }

  const existing = (current || {}) as NitroImportsLike
  const presets = (Array.isArray(existing.presets) ? [...existing.presets] : []) as NitroImportPreset[]
  const found = presets.find(entry => entry?.from === preset.from)

  if (found && Array.isArray(found.imports)) {
    const seen = new Set(found.imports)
    found.imports.push(...preset.imports.filter(name => !seen.has(name)))
  }
  else if (!found) {
    presets.push({ from: preset.from, imports: [...preset.imports] })
  }

  return { ...existing, presets } as never
}
