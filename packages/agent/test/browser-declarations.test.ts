import { resolve } from "node:path"

import ts from "typescript"
import { expect, it } from "vitest"

it("exposes Vue declarations without Node ambient types", () => {
  const dist = resolve(import.meta.dirname, "../dist")
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: ts.ScriptTarget.ESNext,
    types: [],
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile
  // Installed browser consumers do not inherit the workspace's Node globals.
  host.getSourceFile = (fileName, ...args) => fileName.replaceAll("\\", "/").includes("/@types/node/")
    ? undefined
    : getSourceFile(fileName, ...args)
  const entry = resolve(dist, "vue.d.ts")
  const program = ts.createProgram([entry], options, host)
  expect(program.getSourceFile(entry)).toBeDefined()
  const distPrefix = `${dist.replaceAll("\\", "/")}/`
  const diagnostics = program.getSemanticDiagnostics().filter(diagnostic => diagnostic.file?.fileName.replaceAll("\\", "/").startsWith(distPrefix))

  expect(ts.formatDiagnostics(diagnostics, host)).toBe("")
}, 30_000)
