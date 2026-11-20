import { resolve } from "node:path"

import ts from "typescript"
import { expect, it } from "vitest"

const cases = [
  { subpath: "test", name: "runAgentForTest", peersInstalled: false },
  { subpath: "test/emulate-models", name: "emulateModels", peersInstalled: true },
] as const

it.each(cases)("typechecks the built /$subpath entry (emulator peers installed: $peersInstalled)", ({ subpath, name, peersInstalled }) => {
  const packageRoot = resolve(import.meta.dirname, "..")
  const distPrefix = `${resolve(packageRoot, "dist").replaceAll("\\", "/")}/`
  const fixture = resolve(packageRoot, "consumer.mts")
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: ts.ScriptTarget.ESNext,
  }
  const host = ts.createCompilerHost(options)
  const { fileExists, getSourceFile } = host
  if (!peersInstalled) {
    host.fileExists = file => !/\/node_modules\/(?:@emulators\/|emulate\/)/.test(file.replaceAll("\\", "/")) && fileExists(file)
  }
  host.getSourceFile = (file, ...args) => file === fixture
    ? ts.createSourceFile(file, `import { ${name} } from "@vite-hub/agent/${subpath}"; void ${name};`, ts.ScriptTarget.ESNext)
    : getSourceFile(file, ...args)

  const program = ts.createProgram([fixture], options, host)
  const diagnostics = program.getSemanticDiagnostics().filter(({ file }) => {
    return file?.fileName === fixture || file?.fileName.replaceAll("\\", "/").startsWith(distPrefix)
  })
  expect(ts.formatDiagnostics(diagnostics, host)).toBe("")
}, 30_000)
