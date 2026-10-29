import { createRequire } from 'node:module'

import { sandboxTaskErrorDiagnostics } from '../error-diagnostics.ts'

const require = createRequire(import.meta.url)

// Load the compiler on first analysis. Importing `@vite-hub/sandbox/task/vite` must not load it.
// Node caches the module after the first call. TypeScript is an optional peer, so a build reads it from the app.
export function loadTypeScript(): typeof import('typescript') {
  try {
    return require('typescript')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_C0013({ message: '[vitehub] Sandbox Tasks read their definitions with TypeScript. Install `typescript` in the app.' })
  }
}
