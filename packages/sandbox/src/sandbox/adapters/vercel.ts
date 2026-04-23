import type { SandboxExecOptions, SandboxExecResult, SandboxProcess, SandboxProcessOptions, SandboxWaitForPortOptions } from '../types/common'
import type { SandboxNetworkPolicy, VercelSandboxCommandResult, VercelSandboxInstance, VercelSandboxMetadata, VercelSandboxNamespace, VercelSandboxSnapshot } from '../types/vercel'
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { NotSupportedError, SandboxError } from '../errors'
import { normalizeLogPattern, waitForPortProbe } from './_shared'
import { BaseSandboxAdapter } from './base'

function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>
}

function buildCommandLabel(command: string, args: string[]): string {
  return [command, ...args].join(' ').trim()
}

function normalizeVercelExecError(command: string, args: string[], error: unknown): SandboxError {
  if (error instanceof SandboxError)
    return error

  const details = error as {
    message?: string
    response?: { status?: number, url?: string }
  }
  const commandLabel = buildCommandLabel(command, args)
  const messageParts = [`Vercel sandbox exec failed for "${commandLabel}".`]

  if (typeof details?.message === 'string' && details.message)
    messageParts.push(details.message)

  if (details?.response?.status || details?.response?.url) {
    const responseContext = [
      typeof details.response.status === 'number' ? `status ${details.response.status}` : undefined,
      typeof details.response.url === 'string' ? details.response.url : undefined,
    ].filter(Boolean).join(' at ')

    if (responseContext)
      messageParts.push(`Transport: ${responseContext}.`)
  }

  return new SandboxError(messageParts.join(' '), {
    cause: error,
    code: 'VERCEL_SANDBOX_EXEC_FAILED',
    details: { command: commandLabel },
    method: 'exec',
    provider: 'vercel',
  })
}

async function waitForExit(result: VercelSandboxCommandResult, timeout?: number) {
  if (!timeout || timeout <= 0)
    return await result.wait()

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      result.wait(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new SandboxError('Vercel sandbox exec timed out.', {
            code: 'VERCEL_SANDBOX_EXEC_TIMEOUT',
            method: 'exec',
            provider: 'vercel',
          }))
        }, timeout)
      }),
    ])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}

async function collectDetachedCommandOutput(
  result: VercelSandboxCommandResult,
  opts?: SandboxExecOptions,
): Promise<{ code: number, meta: Record<string, unknown>, stderr: string, stdout: string }> {
  let stdout = ''
  let stderr = ''
  let logsError: unknown
  let usedSnapshotFallback = false

  const logsPromise = (async () => {
    try {
      for await (const log of result.logs()) {
        if (log.stream === 'stdout') {
          stdout += log.data
          opts?.onStdout?.(log.data)
        }
        else {
          stderr += log.data
          opts?.onStderr?.(log.data)
        }
      }
    }
    catch (error) {
      logsError = error
    }
  })()

  const waitResult = await waitForExit(result, opts?.timeout)
  await logsPromise

  if (logsError || (!stdout && !stderr)) {
    try {
      usedSnapshotFallback = true
      const [stdoutSnapshot, stderrSnapshot] = await Promise.all([result.stdout(), result.stderr()])
      stdout ||= stdoutSnapshot
      stderr ||= stderrSnapshot
    }
    catch (error) {
      if (!logsError)
        logsError = error
    }
  }

  if (logsError && !stdout && !stderr)
    throw logsError

  return {
    code: waitResult.exitCode,
    meta: {
      detached: true,
      logCollection: usedSnapshotFallback ? 'snapshot-fallback' : 'stream',
    },
    stdout,
    stderr,
  }
}

class VercelProcessHandle implements SandboxProcess {
  readonly id: string
  readonly command: string
  private cmdResult: VercelSandboxCommandResult
  private collectedStdout = ''
  private collectedStderr = ''
  private logsGenerator?: AsyncGenerator<{ stream: 'stdout' | 'stderr', data: string }>
  private logsPump?: Promise<void>
  private logsPumpDone = false
  private logsPumpError?: unknown
  private logEventWaiters: Array<() => void> = []
  private resolvePortUrl?: (port: number) => string

  constructor(id: string, command: string, cmdResult: VercelSandboxCommandResult, resolvePortUrl?: (port: number) => string) {
    this.id = id
    this.command = command
    this.cmdResult = cmdResult
    this.resolvePortUrl = resolvePortUrl
  }

  async kill(_signal?: string): Promise<void> {
    await this.cmdResult.kill()
  }

  private notifyLogEvent(): void {
    const waiters = this.logEventWaiters.splice(0, this.logEventWaiters.length)
    for (const waiter of waiters) {
      waiter()
    }
  }

  private startLogsPump(): void {
    if (this.logsPump) {
      return
    }

    if (!this.logsGenerator) {
      this.logsGenerator = this.cmdResult.logs()
    }

    this.logsPump = (async () => {
      try {
        for await (const log of this.logsGenerator!) {
          if (log.stream === 'stdout') {
            this.collectedStdout += log.data
          }
          else {
            this.collectedStderr += log.data
          }
          this.notifyLogEvent()
        }
      }
      catch (error) {
        this.logsPumpError = error
      }
      finally {
        this.logsPumpDone = true
        this.notifyLogEvent()
      }
    })()
  }

  private async waitForLogEvent(timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0 || this.logsPumpDone) {
      return false
    }

    return new Promise<boolean>((resolve) => {
      const onEvent = (): void => {
        clearTimeout(timeoutId)
        this.logEventWaiters = this.logEventWaiters.filter(waiter => waiter !== onEvent)
        resolve(true)
      }

      const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
        this.logEventWaiters = this.logEventWaiters.filter(waiter => waiter !== onEvent)
        resolve(false)
      }, timeoutMs)

      this.logEventWaiters.push(onEvent)
    })
  }

  private findMatchingLine(regex: RegExp): string | undefined {
    const combined = `${this.collectedStdout}\n${this.collectedStderr}`
    for (const line of combined.split('\n')) {
      if (regex.test(line)) {
        return line
      }
    }
    return undefined
  }

  async logs(): Promise<{ stdout: string, stderr: string }> {
    this.startLogsPump()
    await this.waitForLogEvent(10)
    return { stdout: this.collectedStdout, stderr: this.collectedStderr }
  }

  async wait(timeout?: number): Promise<{ exitCode: number }> {
    const waitResult = timeout
      ? await Promise.race([
          this.cmdResult.wait(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new SandboxError('Process wait timeout', 'TIMEOUT')), timeout)),
        ])
      : await this.cmdResult.wait()

    const rawExitCode = (waitResult as { exitCode?: unknown })?.exitCode
    const exitCode = typeof rawExitCode === 'number' ? rawExitCode : 0
    return { exitCode }
  }

  async waitForLog(pattern: string | RegExp, timeout = 30_000): Promise<{ line: string }> {
    const startTime = Date.now()
    const regex = normalizeLogPattern(pattern)

    this.startLogsPump()
    let matchedLine = this.findMatchingLine(regex)
    if (matchedLine) {
      return { line: matchedLine }
    }

    while (Date.now() - startTime < timeout) {
      if (this.logsPumpError) {
        throw this.logsPumpError
      }

      if (this.logsPumpDone) {
        throw new SandboxError(`Process exited before log pattern was found: ${pattern}`, 'PROCESS_EXITED')
      }

      const remaining = timeout - (Date.now() - startTime)
      await this.waitForLogEvent(Math.min(remaining, 200))
      matchedLine = this.findMatchingLine(regex)
      if (matchedLine) {
        return { line: matchedLine }
      }
    }

    if (this.logsPumpError) {
      throw this.logsPumpError
    }

    throw new SandboxError(`Timeout waiting for log pattern: ${pattern}`, 'TIMEOUT')
  }

  async waitForPort(port: number, opts?: SandboxWaitForPortOptions): Promise<void> {
    await waitForPortProbe(fetch, port, opts, this.resolvePortUrl ? () => this.resolvePortUrl!(port) : undefined)
  }
}

class VercelNamespaceImpl implements VercelSandboxNamespace {
  readonly native: VercelSandboxInstance
  private sandboxId: string
  private _metadata: { runtime: string, createdAt: string }

  constructor(instance: VercelSandboxInstance, sandboxId: string, metadata: { runtime: string, createdAt: string }) {
    this.native = instance
    this.sandboxId = sandboxId
    this._metadata = metadata
  }

  async snapshot(): Promise<VercelSandboxSnapshot> {
    const instanceAny = asRecord(this.native)
    if (typeof instanceAny.snapshot === 'function') {
      return instanceAny.snapshot() as Promise<VercelSandboxSnapshot>
    }
    throw new NotSupportedError('snapshot', 'vercel')
  }

  async getSnapshot(id: string): Promise<VercelSandboxSnapshot> {
    const instanceAny = asRecord(this.native)
    if (typeof instanceAny.getSnapshot === 'function') {
      return instanceAny.getSnapshot(id) as Promise<VercelSandboxSnapshot>
    }
    throw new NotSupportedError('getSnapshot', 'vercel')
  }

  async listSnapshots(): Promise<{ snapshots: VercelSandboxSnapshot[] }> {
    const instanceAny = asRecord(this.native)
    if (typeof instanceAny.listSnapshots === 'function') {
      return instanceAny.listSnapshots() as Promise<{ snapshots: VercelSandboxSnapshot[] }>
    }
    throw new NotSupportedError('listSnapshots', 'vercel')
  }

  async deleteSnapshot(id: string): Promise<void> {
    const instanceAny = asRecord(this.native)
    if (typeof instanceAny.deleteSnapshot === 'function') {
      await (instanceAny.deleteSnapshot as (id: string) => Promise<void>)(id)
      return
    }
    throw new NotSupportedError('deleteSnapshot', 'vercel')
  }

  domain(port: number): string {
    const instanceAny = asRecord(this.native)
    if (typeof instanceAny.domain === 'function') {
      return (instanceAny.domain as (port: number) => string)(port)
    }
    return `https://${this.sandboxId}-${port}.sandbox.vercel.app`
  }

  async extendTimeout(durationMs: number): Promise<void> {
    const instanceAny = asRecord(this.native)
    if (typeof instanceAny.extendTimeout === 'function') {
      await (instanceAny.extendTimeout as (durationMs: number) => Promise<void>)(durationMs)
      return
    }
    throw new NotSupportedError('extendTimeout', 'vercel')
  }

  async updateNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void> {
    const instanceAny = asRecord(this.native)
    if (typeof instanceAny.updateNetworkPolicy === 'function') {
      await (instanceAny.updateNetworkPolicy as (policy: SandboxNetworkPolicy) => Promise<void>)(policy)
      return
    }
    throw new NotSupportedError('updateNetworkPolicy', 'vercel')
  }

  getMetadata(): VercelSandboxMetadata {
    return {
      id: this.sandboxId,
      runtime: this._metadata.runtime,
      status: 'running',
      createdAt: this._metadata.createdAt,
    }
  }
}

export class VercelSandboxAdapter extends BaseSandboxAdapter<'vercel'> {
  readonly id: string
  readonly provider = 'vercel' as const
  readonly native: VercelSandboxInstance
  readonly supports = {
    execEnv: true,
    execCwd: true,
    execSudo: true,
    listFiles: false,
    exists: false,
    deleteFile: false,
    moveFile: false,
    readFileStream: true,
    startProcess: true,
  }

  private _vercel?: VercelSandboxNamespace
  private metadata: { runtime: string, createdAt: string }

  constructor(id: string, instance: VercelSandboxInstance, metadata: { runtime: string, createdAt: string }) {
    super()
    this.id = id
    this.metadata = metadata
    this.native = instance
  }

  override get vercel(): VercelSandboxNamespace {
    if (!this._vercel) {
      this._vercel = new VercelNamespaceImpl(this.native, this.id, this.metadata)
    }
    return this._vercel
  }

  async exec(command: string, args: string[] = [], opts?: SandboxExecOptions): Promise<SandboxExecResult> {
    try {
      const result = await this.native.runCommand({
        cmd: command,
        args,
        cwd: opts?.cwd,
        env: opts?.env,
        sudo: opts?.sudo,
        detached: true,
      })
      const output = await collectDetachedCommandOutput(result, opts)
      return {
        ok: output.code === 0,
        stdout: output.stdout,
        stderr: output.stderr,
        code: output.code,
        meta: {
          ...output.meta,
          command: buildCommandLabel(command, args),
          commandId: asRecord(result).id,
        },
      }
    }
    catch (error) {
      throw normalizeVercelExecError(command, args, error)
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.native.writeFiles([{ path, content: Buffer.from(content) }])
  }

  async readFile(path: string): Promise<string> {
    const buffer = await this.native.readFileToBuffer({ path })
    if (!buffer)
      throw new SandboxError(`Failed to read file: ${path}`)
    return Buffer.from(buffer).toString()
  }

  async stop(): Promise<void> {
    await this.native[Symbol.asyncDispose]?.()
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    if (opts?.recursive) {
      const result = await this.exec('mkdir', ['-p', path])
      if (!result.ok)
        throw new SandboxError(`Failed to create directory: ${path}. ${result.stderr}`)
      return
    }
    await this.native.mkDir(path)
  }

  async readFileStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const stream = await this.native.readFile({ path })
    if (!stream)
      throw new SandboxError(`Failed to read file: ${path}`)
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>
  }

  async startProcess(cmd: string, args: string[] = [], opts?: SandboxProcessOptions): Promise<SandboxProcess> {
    const processId = `vercel-proc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const cmdResult = await this.native.runCommand({
      cmd,
      args,
      cwd: opts?.cwd,
      env: opts?.env,
      detached: true,
    })
    return new VercelProcessHandle(processId, `${cmd} ${args.join(' ')}`, cmdResult, port => this.vercel.domain(port))
  }
}
