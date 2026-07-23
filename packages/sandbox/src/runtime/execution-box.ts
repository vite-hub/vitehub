import type { BoxFiles, BoxSession } from '@vite-hub/box'
import type { ExecutionAuthority } from '@vite-hub/runtime'

export type SandboxExecutionProvider = 'cloudflare' | 'vercel'

export interface SandboxExecutionBox {
  readonly executionAuthority: ExecutionAuthority
  readonly id: string
  readonly files: BoxFiles
  readonly provider: SandboxExecutionProvider
  close(): Promise<void>
  exec(
    command: string,
    args?: readonly string[],
    options?: { cwd?: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal, timeout?: number },
  ): Promise<{ code: number, ok: boolean, stderr: string, stdout: string }>
  exists(path: string): Promise<boolean>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  readFile(path: string): Promise<string>
  writeFile(path: string, contents: string): Promise<void>
}

export function createSandboxExecutionBox(
  session: BoxSession,
  provider: SandboxExecutionProvider,
): SandboxExecutionBox {
  return {
    executionAuthority: session.executionAuthority,
    id: session.id,
    files: session.files,
    provider,
    async close() {
      await session.close()
    },
    async exec(command, args, options) {
      return await session.exec(command, args, options)
    },
    async exists(path) {
      return await session.files.exists(path)
    },
    async mkdir(path, options) {
      await session.files.mkdir(path, options)
    },
    async readFile(path) {
      const contents = await session.files.read(path)
      if (!contents)
        throw new Error(`[vitehub] Sandbox file does not exist: ${path}`)
      return new TextDecoder().decode(contents)
    },
    async writeFile(path, contents) {
      await session.files.write(path, new TextEncoder().encode(contents))
    },
  }
}
