import { NotSupportedError, SandboxError } from '../errors'
import { shellQuote } from '../utils'
import { BaseSandboxAdapter } from './base'
import { CloudflareProcessHandle, type CloudflareProcessHandleCompat } from './cloudflare/process'
import {
  CLOUDFLARE_CONTROL_PLANE_TIMEOUT_MS,
  CLOUDFLARE_READ_FILE_TIMEOUT_MS,
  CLOUDFLARE_STOP_TIMEOUT_MS,
  resolveExecRequestTimeout,
  withCloudflareDeadline,
  withCloudflareTransportRetry,
} from './cloudflare/transport'

import type { CloudflareSandboxNamespace, CloudflareSandboxSession, CloudflareSandboxSessionOptions, SandboxCodeContext, SandboxCodeContextOptions, SandboxCodeExecutionResult, SandboxExposedPort, SandboxExposePortOptions, SandboxGitCheckoutOptions, SandboxGitCheckoutResult, SandboxMountBucketOptions, SandboxRunCodeOptions } from '../types/cloudflare'
import type { CloudflareSandboxStub, SandboxCapabilities, SandboxExecOptions, SandboxExecResult, SandboxFileEntry, SandboxListFilesOptions, SandboxProcess, SandboxProcessOptions } from '../types/common'

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
