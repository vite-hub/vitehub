// Nitro bundles a `?module` WASM import as a compiled WebAssembly.Module, or a promise of one when it loads WASM lazily.
// esbuild with the binary loader bundles it as bytes.
declare module "sh-syntax/main.wasm?module" {
  const wasm: object | Promise<object> | Uint8Array
  export default wasm
}
