import { statSync } from "node:fs"
import { isBuiltin } from "node:module"
import { dirname, extname, resolve } from "node:path"

const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true

/** Resolve relative source imports the same way Vite and Nuxt resolve TypeScript files. */
export function resolveSourceImport(specifier: string, importer: string, require: NodeRequire) {
  if (isBuiltin(specifier)) return
  try { return require.resolve(specifier, { paths: [dirname(importer)] }) }
  catch { /* source-level fallback below */ }
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return
  const base = resolve(dirname(importer), specifier)
  const candidates = extname(base) ? [base] : extensions.map(extension => `${base}${extension}`)
  for (const candidate of candidates) if (isFile(candidate)) return candidate
  for (const extension of extensions.slice(1)) {
    const candidate = `${base}/index${extension}`
    if (isFile(candidate)) return candidate
  }
}
