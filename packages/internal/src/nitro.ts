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
