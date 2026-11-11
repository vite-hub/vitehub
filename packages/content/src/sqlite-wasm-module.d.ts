declare module "@sqlite.org/sqlite-wasm/sqlite3.wasm?module" {
  /** Nitro's WebAssembly support compiles the file at build time and imports it as a `WebAssembly.Module`. */
  const module: object | Promise<object>
  export default module
}
