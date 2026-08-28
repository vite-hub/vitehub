import { copyFile, rename, rm } from 'node:fs/promises'

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
