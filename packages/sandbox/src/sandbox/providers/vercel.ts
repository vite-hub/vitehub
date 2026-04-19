import type { VercelSandboxClient, VercelSandboxInstance, VercelSandboxListItem, VercelSandboxProviderOptions, VercelSandboxSDK } from '../types'
import { VercelSandboxAdapter } from '../adapters'
import { SandboxError } from '../errors'
import type { ResolvedVercelSandboxCredentials } from './shared'

type ResolvedVercelSandboxProvider = VercelSandboxProviderOptions & { credentials?: ResolvedVercelSandboxCredentials }

type VercelSandboxNativeShape = {
  runCommand: unknown
  writeFiles: unknown
  readFileToBuffer: unknown
  readFile: unknown
  mkDir: unknown
  domain: unknown
  [Symbol.asyncDispose]?: () => PromiseLike<void>
}

function wrapVercelSandbox(instance: VercelSandboxNativeShape): VercelSandboxInstance {
  const passthrough = { ...(instance as Record<string, unknown>) }
  const runCommand = (instance.runCommand as VercelSandboxInstance['runCommand']).bind(instance) as VercelSandboxInstance['runCommand']
  const writeFiles = (instance.writeFiles as (files: Array<{ path: string, content: Buffer }>, opts?: { signal?: AbortSignal }) => Promise<void>).bind(instance)
  const readFileToBuffer = (instance.readFileToBuffer as VercelSandboxInstance['readFileToBuffer']).bind(instance) as VercelSandboxInstance['readFileToBuffer']
  const readFile = (instance.readFile as VercelSandboxInstance['readFile']).bind(instance) as VercelSandboxInstance['readFile']
  const mkDir = (instance.mkDir as VercelSandboxInstance['mkDir']).bind(instance) as VercelSandboxInstance['mkDir']
  const domain = (instance.domain as VercelSandboxInstance['domain']).bind(instance) as VercelSandboxInstance['domain']
  const rawAsyncDispose = instance[Symbol.asyncDispose]
  const asyncDispose = typeof rawAsyncDispose === 'function'
    ? async () => {
        await rawAsyncDispose.call(instance)
      }
    : undefined

  return {
    ...passthrough,
    runCommand: ((first: string | Parameters<VercelSandboxInstance['runCommand']>[0], second?: string[] | { signal?: AbortSignal }, third?: { signal?: AbortSignal }) => {
      if (typeof first === 'string') {
        if (Array.isArray(second))
          return runCommand(first, second, third)
        return runCommand(first, undefined, second)
      }
      return runCommand(first)
    }) as VercelSandboxInstance['runCommand'],
    writeFiles: async (files, opts) => await writeFiles(
      files.map(file => ({ path: file.path, content: Buffer.from(file.content.buffer, file.content.byteOffset, file.content.byteLength) })),
      opts,
    ),
    readFileToBuffer: async (opts, opts2) => {
      const buffer = await readFileToBuffer(opts, opts2)
      return buffer ? new Uint8Array(buffer) : null
    },
    readFile,
    mkDir,
    domain,
    ...(asyncDispose ? { [Symbol.asyncDispose]: asyncDispose } : {}),
  } as VercelSandboxInstance
}

async function loadVercelSandbox(): Promise<VercelSandboxSDK> {
  try {
    const module = await import('@vercel/sandbox')
    return {
      Sandbox: {
        create: async options => wrapVercelSandbox(await module.Sandbox.create(options as Parameters<typeof module.Sandbox.create>[0])),
        list: async () => {
          const result = await module.Sandbox.list() as { sandboxes?: VercelSandboxListItem[] }
          return {
            sandboxes: (result.sandboxes || []).map((item) => ({
              id: item.id,
              status: item.status,
              createdAt: item.createdAt,
            })),
          }
        },
        get: async params => {
          const query = typeof params === 'string' ? { sandboxId: params } : params
          const sandbox = await module.Sandbox.get(query)
          return sandbox ? wrapVercelSandbox(sandbox) : null
        },
      },
    }
  }
  catch (error) {
    throw new SandboxError(`@vercel/sandbox load failed. Install it to use the Vercel provider. Original error: ${error instanceof Error ? error.message : error}`)
  }
}

export async function createVercelSandboxClient(provider: ResolvedVercelSandboxProvider): Promise<VercelSandboxClient> {
  const id = `vercel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { runtime = 'node24', timeout = 300_000, cpu, ports, credentials, source, networkPolicy } = provider
  const sdk = await loadVercelSandbox()
  const instance = await sdk.Sandbox.create({
    runtime,
    timeout,
    ports,
    source,
    networkPolicy,
    ...(cpu && { resources: { vcpus: cpu } }),
    ...(credentials && {
      token: credentials.token,
      teamId: credentials.teamId,
      projectId: credentials.projectId,
    }),
  })
  return new VercelSandboxAdapter(id, instance, { runtime, createdAt: new Date().toISOString() })
}

export const VercelSandboxStatic = {
  async list(): Promise<{ sandboxes: VercelSandboxListItem[] }> {
    const sdk = await loadVercelSandbox()
    return sdk.Sandbox.list()
  },

  async get(id: string): Promise<VercelSandboxClient | null> {
    const sdk = await loadVercelSandbox()
    const instance = await sdk.Sandbox.get(id)
    if (!instance)
      return null
    return new VercelSandboxAdapter(id, instance, { runtime: 'unknown', createdAt: 'unknown' })
  },
}
