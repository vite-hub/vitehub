import { glob, readFile } from "node:fs/promises"
import { basename, dirname, extname } from "node:path"

import { parseAst } from "vite"

const sourceFile = /\.[cm]?[jt]sx?$/
const declarationFile = /\.d\.[cm]?ts$/

/**
 * The value names that Nuxt auto-imports from the app's server scan folders, such as `server/utils/`, mapped to the
 * first file that exports each one. Nuxt scans these folders with unimport: named exports, and a default export named
 * after its file. A file that does not parse adds no names, and Nuxt reports its error later.
 */
export async function scanServerExports(dirs: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (const dir of dirs) {
    for await (const file of glob(/[*{]/.test(dir) ? dir : `${dir}/*`)) {
      if (!sourceFile.test(file) || declarationFile.test(file)) continue
      for (const name of await exportNames(file)) if (!names.has(name)) names.set(name, file)
    }
  }
  return names
}

async function exportNames(file: string): Promise<string[]> {
  const lang = /\.[cm]?tsx$/.test(file) ? "tsx" : /\.[cm]?jsx$/.test(file) ? "jsx" : /\.[cm]?ts$/.test(file) ? "ts" : "js"
  let program: ReturnType<typeof parseAst>
  try {
    program = parseAst(await readFile(file, "utf8"), { lang })
  }
  catch {
    return []
  }
  const names: string[] = []
  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration") names.push(defaultExportName(file))
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue
    const declaration = statement.declaration
    if ((declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") && declaration.id) names.push(declaration.id.name)
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) if (declarator.id.type === "Identifier") names.push(declarator.id.name)
    }
    for (const specifier of statement.specifiers) {
      if (specifier.exportKind === "type") continue
      const name = specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value
      names.push(name === "default" ? defaultExportName(file) : name)
    }
  }
  return names
}

function defaultExportName(file: string): string {
  const name = basename(file, extname(file))
  return (name === "index" ? basename(dirname(file)) : name).replace(/[-_.\s]+(\w)/g, (_, letter: string) => letter.toUpperCase())
}
