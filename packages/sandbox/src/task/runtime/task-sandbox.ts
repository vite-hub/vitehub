import type { SandboxFiles, SandboxSession } from '../../index.ts'
import type { ExecutionAuthority } from '@vite-hub/runtime'
import { sandboxTaskErrorDiagnostics } from "../error-diagnostics.ts"

/** `local` runs a Sandbox Task as a process on this machine, which only `vite dev` does. */
export type SandboxTaskExecutionProvider = 'cloudflare' | 'vercel' | 'local'

export interface TaskSandbox {
  readonly executionAuthority: ExecutionAuthority
  readonly id: string
  readonly files: SandboxFiles
  readonly provider: SandboxTaskExecutionProvider
  /** The directory for the files of a run. Commands and file operations must see the same path. */
  readonly tempDir: string
  /** The runner closes this Sandbox after the run, which removes its files with it. */
  readonly closesAfterRun: boolean
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
  closesAfterRun: boolean,
): TaskSandbox {
  return {
    executionAuthority: session.executionAuthority,
    id: session.id,
    files: session.files,
    provider,
    tempDir: provider === 'local' ? `${session.cwd}/tmp` : '/tmp',
    closesAfterRun,
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
