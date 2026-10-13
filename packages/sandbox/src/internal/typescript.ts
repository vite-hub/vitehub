import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Load the compiler on first analysis. Importing `@vite-hub/sandbox/vite` must not load it.
// Node caches the module after the first call.
export function loadTypeScript(): typeof import('typescript') {
  return require('typescript')
}
