import { SandboxError } from '../../errors'
import { normalizeLogPattern, waitForPortProbe } from '../_shared'

import type { SandboxExecOptions, SandboxProcess, SandboxWaitForPortOptions } from '../../types/common'
import type { VercelSandboxCommandResult } from '../../types/vercel'

export async function waitForExit(result: VercelSandboxCommandResult, timeout?: number) {
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

export async function collectDetachedCommandOutput(
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

export class VercelProcessHandle implements SandboxProcess {
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
