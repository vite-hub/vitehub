// oxlint-disable-next-line typescript/triple-slash-reference -- Includes ambient declarations without a runtime import.
/// <reference path="./wasm-module.d.ts" />
import type { File, ShOptions } from "sh-syntax"

import { shellErrorDiagnostics } from "../error-diagnostics.ts"

export type ShellParser = (text: string, options?: ShOptions) => Promise<File>

declare const WebAssembly: {
  Module: abstract new (...args: never[]) => object
  compile(bytes: Uint8Array): Promise<object>
  instantiate(module: object, imports: object): Promise<object>
}

let parser: Promise<ShellParser> | undefined

export async function parseShell(text: string, options?: ShOptions): Promise<File> {
  return (await shellParser())(text, options)
}

export function shellParser(): Promise<ShellParser> {
  parser ??= loadParser().catch((error: unknown) => {
    parser = undefined
    throw error
  })
  return parser
}

async function loadParser(): Promise<ShellParser> {
  const shSyntax: Partial<typeof import("sh-syntax")> & Pick<typeof import("sh-syntax"), "getProcessor"> = await import("sh-syntax")
  const { importError, module: wasm } = await bundledWasmModule()
  if (!wasm) {
    if (!shSyntax.parse || !shSyntax.init) throw shellErrorDiagnostics.SHELL_SH_SYNTAX_WASM_UNAVAILABLE({ cause: importError })
    await shSyntax.init()
    return shSyntax.parse
  }
  const processor = shSyntax.getProcessor((imports: Record<string, unknown>) => WebAssembly.instantiate(wasm, imports))
  await processor.init()
  return (text, options) => processor(text, options)
}

async function bundledWasmModule(): Promise<{ importError?: unknown, module?: object }> {
  let wasm: unknown
  try {
    wasm = await (await import("sh-syntax/main.wasm?module")).default
  }
  catch (importError) {
    return { importError }
  }
  if (wasm instanceof Uint8Array) return { module: await WebAssembly.compile(wasm) }
  return { module: wasm instanceof WebAssembly.Module ? wasm : undefined }
}
