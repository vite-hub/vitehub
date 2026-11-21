// oxlint-disable-next-line typescript/triple-slash-reference -- Includes ambient declarations without a runtime import.
/// <reference path="./wasm-module.d.ts" />
import type { File, ShOptions } from "sh-syntax"

import { shellErrorDiagnostics } from "../error-diagnostics.ts"

type ShellParser = (text: string, options?: ShOptions) => Promise<File>

declare const WebAssembly: {
  Module: abstract new (...args: never[]) => object
  compile(bytes: Uint8Array): Promise<object>
  instantiate(module: object, imports: object): Promise<object>
}

let parser: Promise<ShellParser> | undefined

export async function parseShell(text: string, options?: ShOptions): Promise<File> {
  parser ??= loadParser().catch((error: unknown) => {
    parser = undefined
    throw error
  })
  return (await parser)(text, options)
}

async function loadParser(): Promise<ShellParser> {
  const shSyntax: Partial<typeof import("sh-syntax")> & Pick<typeof import("sh-syntax"), "getProcessor"> = await import("sh-syntax")
  const wasm = await bundledWasmModule()
  if (!wasm) {
    if (!shSyntax.parse) throw shellErrorDiagnostics.SHELL_SH_SYNTAX_WASM_UNAVAILABLE()
    return shSyntax.parse
  }
  const processor = shSyntax.getProcessor(imports => WebAssembly.instantiate(wasm, imports))
  return (text, options) => processor(text, options)
}

async function bundledWasmModule(): Promise<object | undefined> {
  try {
    const wasm = await (await import("sh-syntax/main.wasm?module")).default
    if (wasm instanceof Uint8Array) return await WebAssembly.compile(wasm)
    return wasm instanceof WebAssembly.Module ? wasm : undefined
  }
  catch {
    return undefined
  }
}
