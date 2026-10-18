import type { ScanDir } from 'unimport'

export type ServerImportsOptions = false | {
  autoImport?: boolean
  dirs?: Array<string | ScanDir>
  presets?: unknown[]
} | undefined

export function isServerAutoImportEnabled(imports: ServerImportsOptions): boolean {
  return imports !== false && imports?.autoImport !== false
}
