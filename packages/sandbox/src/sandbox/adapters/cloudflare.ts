import type { CloudflareSandboxNamespace, CloudflareSandboxSession, CloudflareSandboxSessionOptions, SandboxCodeContext, SandboxCodeContextOptions, SandboxCodeExecutionResult, SandboxExposedPort, SandboxExposePortOptions, SandboxGitCheckoutOptions, SandboxGitCheckoutResult, SandboxMountBucketOptions, SandboxRunCodeOptions } from '../types/cloudflare'
import type { CloudflareSandboxStub, SandboxCapabilities, SandboxExecOptions, SandboxExecResult, SandboxFileEntry, SandboxListFilesOptions, SandboxProcess, SandboxProcessOptions, SandboxWaitForPortOptions } from '../types/common'
import { CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE, CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS } from '../../internal/shared/cloudflare-retry'
import { NotSupportedError, SandboxError } from '../errors'
import { shellQuote } from '../utils'
import { normalizeLogPattern, sleep, waitForPortProbe } from './_shared'
import { BaseSandboxAdapter } from './base'

const CLOUDFLARE_CONTROL_PLANE_TIMEOUT_MS = 15_000
const CLOUDFLARE_READ_FILE_TIMEOUT_MS = 15_000
const CLOUDFLARE_STOP_TIMEOUT_MS = 10_000
const CLOUDFLARE_EXEC_REQUEST_TIMEOUT_MS = 180_000

type CloudflareExtendedStub = CloudflareSandboxStub & {
  gitCheckout?: (url: string, opts?: SandboxGitCheckoutOptions) => Promise<SandboxGitCheckoutResult>
  createSession?: (opts?: CloudflareSandboxSessionOptions) => Promise<CloudflareSandboxSession>
  getSession?: (id: string) => Promise<CloudflareSandboxSession>
  deleteSession?: (id: string) => Promise<void>
  createCodeContext?: (opts?: SandboxCodeContextOptions) => Promise<SandboxCodeContext>
  runCode?: (code: string, opts?: SandboxRunCodeOptions) => Promise<SandboxCodeExecutionResult>
  listCodeContexts?: () => Promise<SandboxCodeContext[]>
  deleteCodeContext?: (id: string) => Promise<void>
  exposePort?: (port: number, opts?: SandboxExposePortOptions) => Promise<{ url: string }>
  unexposePort?: (port: number) => Promise<void>
  getExposedPorts?: (hostname?: string) => Promise<SandboxExposedPort[]>
  mountBucket?: (bucket: string, path: string, opts?: SandboxMountBucketOptions) => Promise<void>
  unmountBucket?: (path: string) => Promise<void>
  setEnvVars?: (vars: Record<string, string | undefined>) => Promise<void>
  wsConnect?: (request: Request, port: number) => Promise<Response>
}

type CloudflareProcessHandleCompat = {
  id: string
  command: string
  kill: (signal?: string) => Promise<void>
  getLogs: () => Promise<{ stdout: string, stderr: string }>
  waitForExit: (timeout?: number) => Promise<{ exitCode: number }>
  waitForLog: (pattern: string | RegExp, timeout?: number) => Promise<{ line: string }>
  waitForPort: (port: number, opts?: { timeout?: number, hostname?: string }) => Promise<void>
}

function createCloudflareTransportError(operation: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return new SandboxError(message, {
    cause: error,
    code: 'SANDBOX_TRANSPORT_ERROR',
    details: { operation },
    provider: 'cloudflare',
  })
}

function isRetriableCloudflareTransportError(error: unknown) {
  const sandboxError = error instanceof SandboxError ? error : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (sandboxError?.code === 'TIMEOUT')
    return true
  return CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE.test(message)
}

async function withCloudflareDeadline<T>(operation: string, timeoutMs: number, run: () => Promise<T>) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new SandboxError(`Cloudflare sandbox ${operation} timed out after ${timeoutMs}ms.`, {
            code: 'TIMEOUT',
            details: { operation, timeout: timeoutMs },
            provider: 'cloudflare',
          }))
        }, timeoutMs)
      }),
    ])
  }
  finally {
    if (timeoutId)
      clearTimeout(timeoutId)
  }
}

async function withCloudflareTransportRetry<T>(operation: string, run: () => Promise<T>) {
  const attempts = CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length + 1

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run()
    }
    catch (error) {
      const sandboxError = error instanceof SandboxError
        ? error
        : createCloudflareTransportError(operation, error)

      const shouldRetry = attempt < CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length
        && isRetriableCloudflareTransportError(sandboxError)

      if (!shouldRetry)
        throw sandboxError

      await sleep(CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS[attempt])
    }
  }

  throw new SandboxError(`Cloudflare sandbox ${operation} retries exhausted.`, {
    code: 'SANDBOX_TRANSPORT_ERROR',
    details: { operation },
    provider: 'cloudflare',
  })
}

function resolveExecRequestTimeout(timeout?: number) {
  if (typeof timeout === 'number' && timeout > 0)
    return Math.min(timeout, CLOUDFLARE_EXEC_REQUEST_TIMEOUT_MS)

  return CLOUDFLARE_EXEC_REQUEST_TIMEOUT_MS
}

class CloudflareProcessHandle implements SandboxProcess {
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
      const message = error instanceof Error ? error.message : String(error)
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
    throw new SandboxError(`Timeout waiting for log pattern: ${pattern}`, 'TIMEOUT')
  }

  async waitForPort(port: number, opts?: SandboxWaitForPortOptions): Promise<void> {
    await this.processInfo.waitForPort(port, opts).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!/ProcessExitedBeforeReadyError|before becoming ready|exited with code/i.test(message))
        throw error

      await waitForPortProbe(fetch, port, opts)
    })
  }
}

class CloudflareNamespaceImpl implements CloudflareSandboxNamespace {
  readonly native: CloudflareSandboxStub

  constructor(stub: CloudflareSandboxStub) {
    this.native = stub
  }

  private get extendedStub(): CloudflareExtendedStub {
    return this.native as CloudflareExtendedStub
  }

  async gitCheckout(url: string, opts?: SandboxGitCheckoutOptions): Promise<SandboxGitCheckoutResult> {
    if (typeof this.extendedStub.gitCheckout === 'function')
      return this.extendedStub.gitCheckout(url, opts)
    throw new NotSupportedError('gitCheckout', 'cloudflare')
  }

  async createSession(opts?: CloudflareSandboxSessionOptions): Promise<CloudflareSandboxSession> {
    if (typeof this.extendedStub.createSession === 'function')
      return this.extendedStub.createSession(opts)
    throw new NotSupportedError('createSession', 'cloudflare')
  }

  async getSession(id: string): Promise<CloudflareSandboxSession> {
    if (typeof this.extendedStub.getSession === 'function')
      return this.extendedStub.getSession(id)
    throw new NotSupportedError('getSession', 'cloudflare')
  }

  async deleteSession(id: string): Promise<void> {
    if (typeof this.extendedStub.deleteSession === 'function') {
      await this.extendedStub.deleteSession(id)
      return
    }
    throw new NotSupportedError('deleteSession', 'cloudflare')
  }

  async createCodeContext(opts?: SandboxCodeContextOptions): Promise<SandboxCodeContext> {
    if (typeof this.extendedStub.createCodeContext === 'function')
      return this.extendedStub.createCodeContext(opts)
    throw new NotSupportedError('createCodeContext', 'cloudflare')
  }

  async runCode(code: string, opts?: SandboxRunCodeOptions): Promise<SandboxCodeExecutionResult> {
    if (typeof this.extendedStub.runCode === 'function')
      return this.extendedStub.runCode(code, opts)
    throw new NotSupportedError('runCode', 'cloudflare')
  }

  async listCodeContexts(): Promise<SandboxCodeContext[]> {
    if (typeof this.extendedStub.listCodeContexts === 'function')
      return this.extendedStub.listCodeContexts()
    throw new NotSupportedError('listCodeContexts', 'cloudflare')
  }

  async deleteCodeContext(id: string): Promise<void> {
    if (typeof this.extendedStub.deleteCodeContext === 'function') {
      await this.extendedStub.deleteCodeContext(id)
      return
    }
    throw new NotSupportedError('deleteCodeContext', 'cloudflare')
  }

  async exposePort(port: number, opts?: SandboxExposePortOptions): Promise<{ url: string }> {
    if (!opts?.hostname)
      throw new SandboxError('Cloudflare exposePort() requires opts.hostname. Use a custom domain (not *.workers.dev).', 'INVALID_ARGUMENT')
    if (typeof this.extendedStub.exposePort === 'function')
      return this.extendedStub.exposePort(port, opts)
    throw new NotSupportedError('exposePort', 'cloudflare')
  }

  async unexposePort(port: number): Promise<void> {
    if (typeof this.extendedStub.unexposePort === 'function') {
      await this.extendedStub.unexposePort(port)
      return
    }
    throw new NotSupportedError('unexposePort', 'cloudflare')
  }

  async getExposedPorts(hostname?: string): Promise<SandboxExposedPort[]> {
    if (!hostname)
      throw new SandboxError('Cloudflare getExposedPorts() requires a hostname argument. Use your custom domain hostname.', 'INVALID_ARGUMENT')
    if (typeof this.extendedStub.getExposedPorts === 'function')
      return this.extendedStub.getExposedPorts(hostname)
    throw new NotSupportedError('getExposedPorts', 'cloudflare')
  }

  async mountBucket(bucket: string, path: string, opts?: SandboxMountBucketOptions): Promise<void> {
    if (typeof this.extendedStub.mountBucket === 'function') {
      await this.extendedStub.mountBucket(bucket, path, opts)
      return
    }
    throw new NotSupportedError('mountBucket', 'cloudflare')
  }

  async unmountBucket(path: string): Promise<void> {
    if (typeof this.extendedStub.unmountBucket === 'function') {
      await this.extendedStub.unmountBucket(path)
      return
    }
    throw new NotSupportedError('unmountBucket', 'cloudflare')
  }

  async setEnvVars(vars: Record<string, string | undefined>): Promise<void> {
    if (typeof this.extendedStub.setEnvVars === 'function') {
      await this.extendedStub.setEnvVars(vars)
      return
    }
    throw new NotSupportedError('setEnvVars', 'cloudflare')
  }

  async wsConnect(request: Request, port: number): Promise<Response> {
    if (typeof this.extendedStub.wsConnect === 'function')
      return this.extendedStub.wsConnect(request, port)
    throw new NotSupportedError('wsConnect', 'cloudflare')
  }
}

export class CloudflareSandboxAdapter extends BaseSandboxAdapter<'cloudflare'> {
  readonly id: string
  readonly provider = 'cloudflare' as const
  readonly native: CloudflareSandboxStub
  private _cloudflare?: CloudflareSandboxNamespace

  constructor(id: string, stub: CloudflareSandboxStub) {
    super()
    this.id = id
    this.native = stub
  }

  get supports(): SandboxCapabilities {
    return {
      execEnv: true,
      execCwd: true,
      execSudo: false,
      listFiles: true,
      exists: true,
      deleteFile: true,
      moveFile: true,
      readFileStream: true,
      startProcess: !!this.native.startProcess,
    }
  }

  override get cloudflare(): CloudflareSandboxNamespace {
    if (!this._cloudflare)
      this._cloudflare = new CloudflareNamespaceImpl(this.native)
    return this._cloudflare
  }

  async exec(command: string, args: string[] = [], opts?: SandboxExecOptions): Promise<SandboxExecResult> {
    const cmd = args.length ? `${shellQuote(command)} ${args.map(shellQuote).join(' ')}` : shellQuote(command)
    const result = await withCloudflareTransportRetry('exec', async () => await withCloudflareDeadline('exec', resolveExecRequestTimeout(opts?.timeout), async () => await this.native.exec(cmd, {
      timeout: opts?.timeout,
      env: opts?.env,
      cwd: opts?.cwd,
      stream: !!(opts?.onStdout || opts?.onStderr),
      onOutput: (opts?.onStdout || opts?.onStderr)
        ? (stream, data) => {
            if (stream === 'stdout')
              opts?.onStdout?.(data)
            if (stream === 'stderr')
              opts?.onStderr?.(data)
          }
        : undefined,
    })))
    return { ok: result.success, stdout: result.stdout, stderr: result.stderr, code: result.exitCode }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const result = await withCloudflareTransportRetry('writeFile', async () => await withCloudflareDeadline('writeFile', CLOUDFLARE_CONTROL_PLANE_TIMEOUT_MS, async () => await this.native.writeFile(path, content)))
    if (!result.success)
      throw new SandboxError(`Failed to write file: ${path}`)
  }

  async readFile(path: string): Promise<string> {
    const result = await withCloudflareTransportRetry('readFile', async () => await withCloudflareDeadline('readFile', CLOUDFLARE_READ_FILE_TIMEOUT_MS, async () => await this.native.readFile(path)))
    if (!result.success)
      throw new SandboxError(`Failed to read file: ${path}`)
    return result.content
  }

  async stop(): Promise<void> {
    await withCloudflareTransportRetry('destroy', async () => await withCloudflareDeadline('destroy', CLOUDFLARE_STOP_TIMEOUT_MS, async () => await this.native.destroy()))
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    if (this.native.mkdir) {
      const result = await withCloudflareTransportRetry('mkdir', async () => await withCloudflareDeadline('mkdir', CLOUDFLARE_CONTROL_PLANE_TIMEOUT_MS, async () => await this.native.mkdir!(path, opts)))
      if (!result.success)
        throw new SandboxError(`Failed to create directory: ${path}`)
      return
    }
    const result = await this.exec('mkdir', opts?.recursive ? ['-p', path] : [path])
    if (!result.ok)
      throw new SandboxError(`Failed to create directory: ${path}. ${result.stderr}`)
  }

  async readFileStream(path: string): Promise<ReadableStream<Uint8Array>> {
    if (this.native.readFileStream)
      return this.native.readFileStream(path)
    const content = await this.readFile(path)
    const encoder = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(content))
        controller.close()
      },
    })
  }

  async startProcess(cmd: string, args: string[] = [], opts?: SandboxProcessOptions): Promise<SandboxProcess> {
    if (!this.native.startProcess)
      throw new NotSupportedError('startProcess', 'cloudflare')

    const processInfo = await this.native.startProcess(args.length ? `${shellQuote(cmd)} ${args.map(shellQuote).join(' ')}` : shellQuote(cmd), opts) as CloudflareProcessHandleCompat
    if (
      typeof processInfo.getLogs !== 'function'
      || typeof processInfo.waitForExit !== 'function'
      || typeof processInfo.waitForLog !== 'function'
      || typeof processInfo.waitForPort !== 'function'
    )
      throw new SandboxError('Cloudflare process handles must provide getLogs(), waitForExit(), waitForLog(), and waitForPort().', 'NOT_SUPPORTED')

    return new CloudflareProcessHandle(processInfo.id, processInfo.command, {
      kill: processInfo.kill.bind(processInfo),
      getLogs: processInfo.getLogs.bind(processInfo),
      waitForExit: processInfo.waitForExit.bind(processInfo),
      waitForLog: processInfo.waitForLog.bind(processInfo),
      waitForPort: processInfo.waitForPort.bind(processInfo),
    })
  }

  override async listFiles(path: string, opts?: SandboxListFilesOptions): Promise<SandboxFileEntry[]> {
    if (this.native.listFiles) {
      const result = await this.native.listFiles(path, opts)
      return result.files
        .filter((file): file is typeof file & { type: 'file' | 'directory' } => file.type === 'file' || file.type === 'directory')
        .map(file => ({ name: file.name, path: file.absolutePath, type: file.type, size: file.size, mtime: file.modifiedAt }))
    }
    const result = await this.exec('ls', [opts?.recursive ? '-laR' : '-la', path])
    if (!result.ok)
      throw new SandboxError(`Failed to list files: ${path}. ${result.stderr}`)
    return result.stdout.split('\n')
      .filter(Boolean)
      .slice(1)
      .map((line) => {
        const parts = line.split(/\s+/)
        const name = parts[parts.length - 1] || ''
        return {
          name,
          path: `${path}/${name}`,
          type: (line.startsWith('d') ? 'directory' : 'file') as 'file' | 'directory',
        }
      })
      .filter(file => file.name && file.name !== '.' && file.name !== '..')
  }

  override async exists(path: string): Promise<boolean> {
    if (this.native.exists) {
      const result = await this.native.exists(path)
      return result.exists
    }
    try {
      const result = await this.exec('test', ['-e', path])
      return result.ok
    }
    catch {
      return false
    }
  }

  override async deleteFile(path: string): Promise<void> {
    if (this.native.deleteFile) {
      const result = await this.native.deleteFile(path)
      if (!result.success)
        throw new SandboxError(`Failed to delete file: ${path}`)
      return
    }
    const result = await this.exec('rm', ['-f', path])
    if (!result.ok)
      throw new SandboxError(`Failed to delete file: ${path}. ${result.stderr}`)
  }

  override async moveFile(src: string, dst: string): Promise<void> {
    if (this.native.moveFile) {
      const result = await this.native.moveFile(src, dst)
      if (!result.success)
        throw new SandboxError(`Failed to move file: ${src} -> ${dst}`)
      return
    }
    const result = await this.exec('mv', [src, dst])
    if (!result.ok)
      throw new SandboxError(`Failed to move file: ${src} -> ${dst}. ${result.stderr}`)
  }
}
