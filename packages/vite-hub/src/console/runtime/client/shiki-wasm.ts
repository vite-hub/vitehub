// The Console build resolves `shiki/wasm` here. The Console highlights code with Shiki's JavaScript regex engine, so
// the bundle leaves out the Oniguruma WebAssembly engine that `@pierre/diffs` imports for its `shiki-wasm` option.
throw new Error("The ViteHub Console does not include the Shiki WebAssembly engine. Use the JavaScript regex engine.");

export {};
