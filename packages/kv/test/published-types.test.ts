import { resolve } from "node:path"

import ts from "typescript"
import { expect, it } from "vitest"

it("typechecks published KV declarations without unrelated driver SDKs", () => {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: ts.ScriptTarget.ESNext,
    types: ["node"],
  }
  const host = ts.createCompilerHost(options)
  const program = ts.createProgram([
    resolve(import.meta.dirname, "../dist/index.d.ts"),
    resolve(import.meta.dirname, "../dist/vite.d.ts"),
  ], options, host)

  expect(ts.formatDiagnostics(ts.getPreEmitDiagnostics(program), host)).toBe("")
}, 30_000)
