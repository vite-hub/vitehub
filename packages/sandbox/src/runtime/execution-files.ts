import { createWorkspace } from '@vite-hub/workspace/internal/runtime/workspace'
import { dirname } from 'pathe'

import type { SandboxDefinitionBundle } from '../module-types'
import type { SandboxExecutionBox } from './execution-box'

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
  if (modulePath === '.')
    return baseDir
  return `${baseDir}/${modulePath}`
}

export async function writeSandboxDefinitionBundle(sandbox: SandboxExecutionBox, baseDir: string, bundle: SandboxDefinitionBundle) {
  const workspace = createWorkspace({
    name: `sandbox-${bundle.project?.digest || Math.random().toString(36).slice(2)}`,
    store: { provider: 'memory' },
  })
  const files = {
    ...(bundle.project
      ? Object.fromEntries(Object.entries(bundle.project.files).map(([path, file]) => [path, Uint8Array.from(Buffer.from(file.contents, file.encoding))]))
      : {}),
    ...bundle.modules,
  }
  await Promise.all(Object.entries(files).map(async ([modulePath, source]) => {
    const parent = dirname(modulePath)
    if (parent !== '.') await workspace.mkdir(parent, { recursive: true })
    await workspace.writeFile(modulePath, source)
  }))
  await workspace.snapshot({ name: 'sandbox-bundle' })
  const session = await workspace.startSession({ host: sandbox, target: baseDir })
  await session.close()
}
