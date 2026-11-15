// oxlint-disable-next-line typescript/triple-slash-reference -- Includes ambient declarations without a runtime import.
/// <reference path="./wasm-module.d.ts" />
import type { File, ShOptions } from "sh-syntax"

type ShellParser = (text: string, options?: ShOptions) => Promise<File>

// The package compiles without the DOM lib, so declare the WebAssembly API that this module uses.
declare const WebAssembly: {
  Module: abstract new (...args: never[]) => object
  compile(bytes: Uint8Array): Promise<object>
  instantiate(module: object, imports: object): Promise<object>
}

let parser: Promise<ShellParser> | undefined

export async function parseShell(text: string, options?: ShOptions): Promise<File> {
  // A failed load lets the next parse try again.
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
    // Without a bundler, sh-syntax reads main.wasm next to its own files.
    if (!shSyntax.parse) throw new Error("[vitehub] sh-syntax cannot load its WebAssembly parser on this host.")
    return shSyntax.parse
  }
  // A bundled sh-syntax can't find main.wasm on disk, and Workers can't compile WebAssembly from bytes.
  // Nitro bundles this import as a compiled module, and esbuild as bytes.
  const processor = shSyntax.getProcessor(imports => WebAssembly.instantiate(wasm, imports))
  return (text, options) => processor(text, options)
}

async function bundledWasmModule(): Promise<object | undefined> {
  try {
    const wasm = await (await import("sh-syntax/main.wasm?module")).default
    // esbuild bundles the file as bytes. Vite's dev server serves it as an asset URL, which is neither.
    if (wasm instanceof Uint8Array) return await WebAssembly.compile(wasm)
    return wasm instanceof WebAssembly.Module ? wasm : undefined
  }
  catch {
    // Node.js without a bundler can't import a `?module` URL.
    return undefined
  }
}
