import { readSandboxErrorInternals, SandboxError } from '../../errors'
import { isSandboxAbort } from '../../provider-call'
import { normalizeLogPattern, sleep } from '../_shared'

import type { SandboxProcess, SandboxWaitForPortOptions } from '../../types/common'

export type CloudflareNativeProcessHandle = {
  id: string
  command: string
  kill: (signal?: string) => Promise<void>
  getLogs: () => Promise<{ stdout: string, stderr: string }>
  waitForExit: (timeout?: number) => Promise<{ exitCode: number }>
  waitForLog: (pattern: string | RegExp, timeout?: number) => Promise<{ line: string }>
  waitForPort: (port: number, opts?: { timeout?: number, hostname?: string }) => Promise<void>
}

export class CloudflareProcessHandle implements SandboxProcess {
  readonly id: string
  readonly command: string
  private processInfo: {
    kill: (signal?: string) => Promise<void>
    getLogs: () => Promise<{ stdout: string, stderr: string }>
    waitForExit: (timeout?: number) => Promise<{ exitCode: number }>
    waitForLog: (pattern: string | RegExp, timeout?: number) => Promise<{ line: string }>
    waitForPort: (port: number, opts?: { timeout?: number, hostname?: string }) => Promise<void>
  }

  constructor(id: string, command: string, processInfo: CloudflareProcessHandle['processInfo']) {
    this.id = id
    this.command = command
    this.processInfo = processInfo
  }

  async kill(signal?: string): Promise<void> {
    await this.processInfo.kill(signal)
  }

  async logs(): Promise<{ stdout: string, stderr: string }> {
    return this.processInfo.getLogs()
  }

  async wait(timeout?: number): Promise<{ exitCode: number }> {
    return this.processInfo.waitForExit(timeout)
  }

  async waitForLog(pattern: string | RegExp, timeout = 30_000): Promise<{ line: string }> {
    try {
      return await this.processInfo.waitForLog(pattern, timeout)
    }
    catch (error) {
      if (isSandboxAbort(error))
        throw error
      const message = error instanceof SandboxError
        ? readSandboxErrorInternals(error).message
        : error instanceof Error ? error.message : String(error)
      if (!/ProcessExitedBeforeReadyError|before becoming ready|exited with code/i.test(message))
        throw error
    }

    const startTime = Date.now()
    const regex = normalizeLogPattern(pattern)
    while (Date.now() - startTime < timeout) {
      const { stdout, stderr } = await this.logs()
      for (const line of `${stdout}${stderr}`.split('\n')) {
        if (regex.test(line))
          return { line }
      }
      await sleep(100)
    }
    throw new SandboxError({
      code: 'SANDBOX_TIMEOUT',
      details: { pattern: String(pattern) },
      message: `Timeout waiting for log pattern: ${pattern}`,
    })
  }

  async waitForPort(port: number, opts?: SandboxWaitForPortOptions): Promise<void> {
    await this.processInfo.waitForPort(port, opts)
  }
}
