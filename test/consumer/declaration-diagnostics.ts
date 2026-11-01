import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

export interface DeclarationProgram {
  // Diagnostics show file names relative to this directory.
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

export function isPackageDeclarationDiagnostic(diagnostic: ts.Diagnostic, packageName?: string) {
  const path = diagnostic.file?.fileName.replaceAll("\\", "/") || ""
  if (!path.includes("/node_modules/")) return true
  // Dependency declarations have their own release contracts. Keep this test
  // scoped to diagnostics emitted by the packed ViteHub package itself.
  return packageName ? path.includes(`/node_modules/${packageName}/`) : true
}

function declarationDiagnostics({ displayDirectory, options, packageName, rootNames }: DeclarationProgram): DeclarationDiagnostic[] {
  const program = ts.createProgram(rootNames, options)
  const host: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => displayDirectory,
    getNewLine: () => "\n",
  }
  return ts.getPreEmitDiagnostics(program)
    .filter(diagnostic => isPackageDeclarationDiagnostic(diagnostic, packageName))
    .map(diagnostic => ({
      code: diagnostic.code,
      fileName: diagnostic.file?.fileName,
      text: ts.formatDiagnosticsWithColorAndContext([diagnostic], host),
    }))
}

// The consumer contract runs each program in its own Node process, so the
// programs check in parallel instead of blocking the test's event loop.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // SAFETY: The consumer contract passes a JSON-encoded DeclarationProgram.
  const program = JSON.parse(process.argv[2]!) as DeclarationProgram
  process.stdout.write(JSON.stringify(declarationDiagnostics(program)))
}
