import { copyFile, readFile, rename, rm } from 'node:fs/promises'
import { basename, resolve } from 'pathe'

const generationMarker = '// vitehub-sandbox-generation: '

export function markSandboxRuntimeGeneration(contents: string, generationDir: string): string {
  return `${generationMarker}${basename(generationDir)}\n${contents}`
}

export async function readSandboxRuntimeGeneration(
  facadeFile: string,
  generationsDir: string,
): Promise<string | undefined> {
  const contents = await readFile(facadeFile, 'utf8').catch(() => undefined)
  const name = contents?.split('\n', 1)[0]?.slice(generationMarker.length)
  return name?.startsWith('runtime-') && basename(name) === name ? resolve(generationsDir, name) : undefined
}

interface SandboxRuntimeFileOperations {
  copyFile: typeof copyFile
  rename: typeof rename
  rm: typeof rm
}

export async function activateSandboxRuntimeFile(
  source: string,
  target: string,
  staged: string,
  operations: SandboxRuntimeFileOperations = { copyFile, rename, rm },
): Promise<void> {
  await operations.copyFile(source, staged)
  try {
    await operations.rename(staged, target)
  }
  finally {
    await operations.rm(staged, { force: true }).catch(() => {})
  }
}

export function resolveSandboxRuntimeLinkType(platform: NodeJS.Platform): 'dir' | 'junction' {
  return platform === 'win32' ? 'junction' : 'dir'
}

export async function pruneSandboxRuntimeGeneration(
  path: string,
  remove: typeof rm = rm,
): Promise<void> {
  await remove(path, { recursive: true, force: true }).catch(() => {})
}
