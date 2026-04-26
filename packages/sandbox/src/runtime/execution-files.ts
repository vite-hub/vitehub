import { dirname } from 'pathe'

import type { SandboxClient } from '../sandbox/types'
import type { SandboxDefinitionBundle } from '../module-types'

const DEFAULT_DEFINITION_ENTRY = 'definition.js'

export type SandboxDefinitionSource = SandboxDefinitionBundle | string

export function normalizeSandboxDefinitionBundle(source: SandboxDefinitionSource): SandboxDefinitionBundle {
  if (typeof source === 'string') {
    return {
      entry: DEFAULT_DEFINITION_ENTRY,
      modules: {
        [DEFAULT_DEFINITION_ENTRY]: source,
      },
    }
  }

  return source
}

export function createExecutionFiles(definitionName: string) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const baseDir = `/tmp/vitehub-sandbox/${definitionName.replace(/[^a-z0-9/_-]/gi, '_')}-${nonce}`
  return {
    baseDir,
    entryPath: `${baseDir}/entry.mjs`,
    inputPath: `${baseDir}/input.json`,
    outputPath: `${baseDir}/output.json`,
  }
}

export function resolveSandboxModulePath(baseDir: string, modulePath: string) {
  return `${baseDir}/${modulePath}`
}

export async function writeSandboxDefinitionBundle(sandbox: SandboxClient, baseDir: string, bundle: SandboxDefinitionBundle) {
  await Promise.all(Object.entries(bundle.modules).map(async ([modulePath, source]) => {
    const filePath = resolveSandboxModulePath(baseDir, modulePath)
    await sandbox.mkdir(dirname(filePath), { recursive: true })
    await sandbox.writeFile(filePath, source)
  }))
}
