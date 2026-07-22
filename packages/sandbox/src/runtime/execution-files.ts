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
    inputAssetsDir: `${baseDir}/input.json.files`,
    inputPath: `${baseDir}/input.json`,
    outputAssetsDir: `${baseDir}/output.json.files`,
    outputPath: `${baseDir}/output.json`,
  }
}

export function resolveSandboxModulePath(baseDir: string, modulePath: string) {
  if (modulePath === '.')
    return baseDir
  return `${baseDir}/${modulePath}`
}

function normalizeSandboxBundlePath(path: string) {
  const slashPath = path.replace(/\\/g, '/')
  const normalized = slashPath.replace(/^\/+|\/+$/g, '')
  const parts = normalized.split('/').filter(Boolean)
  if (!normalized || slashPath.startsWith('/') || /^[A-Za-z]:\//.test(slashPath) || parts.some(part => part === '.' || part === '..'))
    throw new Error(`[vitehub] Sandbox bundle path must stay inside the project: ${path}.`)
  return parts.join('/')
}

export async function writeSandboxDefinitionBundle(sandbox: SandboxExecutionBox, baseDir: string, bundle: SandboxDefinitionBundle) {
  const files = Object.entries({
    ...(bundle.project
      ? Object.fromEntries(Object.entries(bundle.project.files).map(([path, file]) => [path, Uint8Array.from(Buffer.from(file.contents, file.encoding))]))
      : {}),
    ...bundle.modules,
  }).map(([path, source]) => ({ path: normalizeSandboxBundlePath(path), source }))
  const modes = Object.entries(bundle.project?.files || {})
    .filter(([, file]) => Boolean(file.mode))
    .map(([path, file]) => ({ mode: file.mode!, path: normalizeSandboxBundlePath(path) }))
  await sandbox.files.remove(baseDir, { recursive: true })
  await sandbox.files.mkdir(baseDir, { recursive: true })
  await Promise.all(files.map(async ({ path, source }) => {
    const parent = dirname(path)
    if (parent !== '.') await sandbox.files.mkdir(`${baseDir}/${parent}`, { recursive: true })
    await sandbox.files.write(`${baseDir}/${path}`, typeof source === 'string' ? new TextEncoder().encode(source) : source)
  }))
  await Promise.all(modes.map(async ({ mode, path }) => {
    await sandbox.exec('chmod', [mode.toString(8), `${baseDir}/${path}`])
  }))
}
