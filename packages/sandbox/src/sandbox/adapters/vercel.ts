import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import { NotSupportedError, SandboxError } from '../errors'
import { BaseSandboxAdapter } from './base'
import { asRecord, buildCommandLabel, normalizeVercelExecError } from './vercel/error'
import { collectDetachedCommandOutput, VercelProcessHandle } from './vercel/process'

import type { SandboxExecOptions, SandboxExecResult, SandboxProcess, SandboxProcessOptions } from '../types/common'
import type { SandboxNetworkPolicy, VercelSandboxInstance, VercelSandboxMetadata, VercelSandboxNamespace, VercelSandboxSnapshot } from '../types/vercel'

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
