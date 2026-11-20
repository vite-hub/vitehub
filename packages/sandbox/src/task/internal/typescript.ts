import { createRequire } from 'node:module'

import { sandboxTaskErrorDiagnostics } from '../error-diagnostics.ts'

const require = createRequire(import.meta.url)

export function loadTypeScript(): typeof import('typescript') {
  try {
    return require('typescript')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_C0013({ message: '[vitehub] Sandbox Tasks read their definitions with TypeScript. Install `typescript` in the app.' })
  }
}
