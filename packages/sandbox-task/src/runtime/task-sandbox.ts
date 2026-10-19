import type { SandboxFiles, SandboxSession } from '@vite-hub/sandbox'
import type { ExecutionAuthority } from '@vite-hub/runtime'
import { sandboxTaskErrorDiagnostics } from "../error-diagnostics.ts"

export type SandboxTaskExecutionProvider = 'cloudflare' | 'vercel'

export interface TaskSandbox {
  readonly executionAuthority: ExecutionAuthority
  readonly id: string
  readonly files: SandboxFiles
  readonly provider: SandboxTaskExecutionProvider
  close(): Promise<void>
  exec(
    command: string,
    args?: readonly string[],
    options?: { cwd?: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal, timeout?: number },
  ): Promise<{ code: number, ok: boolean, stderr: string, stdout: string }>
  exists(path: string, options?: { signal?: AbortSignal }): Promise<boolean>
  mkdir(path: string, options?: { recursive?: boolean, signal?: AbortSignal }): Promise<void>
  readFile(path: string, options?: { signal?: AbortSignal }): Promise<string>
  writeFile(path: string, contents: string, options?: { signal?: AbortSignal }): Promise<void>
}

export function createTaskSandbox(
  session: SandboxSession,
  provider: SandboxTaskExecutionProvider,
): TaskSandbox {
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
    async exists(path, options) {
      return await session.files.exists(path, options)
    },
    async mkdir(path, options) {
      await session.files.mkdir(path, options)
    },
    async readFile(path, options) {
      const contents = await session.files.read(path, options)
      if (!contents)
        throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0066({ message: `[vitehub] Sandbox file does not exist: ${path}` })
      return new TextDecoder().decode(contents)
    },
    async writeFile(path, contents, options) {
      await session.files.write(path, new TextEncoder().encode(contents), options)
    },
  }
}
