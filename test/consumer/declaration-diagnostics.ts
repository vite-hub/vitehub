import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

export interface DeclarationProgram {
  displayDirectory: string
  options: ts.CompilerOptions
  packageName?: string
  rootNames: string[]
}

export interface DeclarationDiagnostic {
  code: number
  fileName?: string
  text: string
}

export function isPackageDeclarationFile(fileName: string, packageName?: string) {
  const path = fileName.replaceAll("\\", "/")
  if (!path.includes("/node_modules/")) return true
  return packageName ? path.includes(`/node_modules/${packageName}/`) : true
}

function declarationDiagnostics({ displayDirectory, options, packageName, rootNames }: DeclarationProgram): DeclarationDiagnostic[] {
  const program = ts.createProgram(rootNames, options)
  const files = program.getSourceFiles().filter(file => isPackageDeclarationFile(file.fileName, packageName))
  const host: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => displayDirectory,
    getNewLine: () => "\n",
  }
  const diagnostics = ts.sortAndDeduplicateDiagnostics([
    ...program.getOptionsDiagnostics(),
    ...files.flatMap(file => program.getSyntacticDiagnostics(file)),
    ...program.getGlobalDiagnostics(),
    ...files.flatMap(file => program.getSemanticDiagnostics(file)),
  ])
  return diagnostics.map(diagnostic => ({
    code: diagnostic.code,
    fileName: diagnostic.file?.fileName,
    text: ts.formatDiagnosticsWithColorAndContext([diagnostic], host),
  }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // SAFETY: The consumer contract passes a JSON-encoded DeclarationProgram.
  const program = JSON.parse(process.argv[2]!) as DeclarationProgram
  process.stdout.write(JSON.stringify(declarationDiagnostics(program)))
}
