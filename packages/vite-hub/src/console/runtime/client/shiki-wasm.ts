// The Console build resolves `shiki/wasm` here. The Console highlights code with Shiki's JavaScript regex engine, so
// the bundle leaves out the Oniguruma WebAssembly engine that `@pierre/diffs` imports for its `shiki-wasm` option.
import { invariantError } from "@vite-hub/internal/invariant";

throw invariantError("the Console highlights code with the Shiki JavaScript regex engine, never the WebAssembly engine");
