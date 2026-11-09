// Nitro bundles a `?module` WASM import as a compiled WebAssembly.Module, or a promise of one when it loads WASM lazily.
declare module "sh-syntax/main.wasm?module" {
  const wasm: object | Promise<object>
  export default wasm
}
