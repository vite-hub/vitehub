import { CLOUDFLARE_CONTROL_PLANE_TIMEOUT_MS, createCloudflareTransportError, resolveExecRequestTimeout, withCloudflareDeadline } from '../sandbox/adapters/cloudflare/transport'
import { SandboxError } from '../sandbox/errors'
import { shellQuote } from '../sandbox/utils'
import { createEntrySource } from './entry-script'
import {
  createExecutionFiles,
  normalizeSandboxDefinitionBundle,
  resolveSandboxModulePath,
  writeSandboxDefinitionBundle,
  type SandboxDefinitionSource,
} from './execution-files'
import {
  createHandlerError,
  createTimeoutError,
  extractSandboxOutputFromExecution,
  readExecOutputWithRecovery,
  recoverExecOutput,
  tryParseSandboxOutput,
} from './output-recovery'

import type { CloudflareSandboxClient, SandboxClient } from '../sandbox/types'
import type { SandboxDefinitionOptions, SandboxDefinitionRuntime } from '../module-types'

const defaultNodeLauncher = 'import(process.argv[1])'

function toJson(value: unknown, label: string) {
  try {
    return JSON.stringify(value)
  }
  catch (error) {
    throw new SandboxError(`Sandbox ${label} must be JSON-serializable.`, {
      code: 'SERIALIZATION_ERROR',
      details: { label },
      cause: error,
    })
  }
}

function resolveLauncher(_provider: SandboxClient['provider'], runtime?: SandboxDefinitionRuntime) {
  if (runtime) {
    return {
      command: runtime.command,
      args: [...(runtime.args || [])],
    }
  }

  return {
    command: 'node',
    args: ['-e', defaultNodeLauncher],
  }
}

async function executeLauncher(
  sandbox: SandboxClient,
  command: string,
  args: string[],
  options: { cwd?: string, deadline?: number, env?: Record<string, string>, signal?: AbortSignal, timeout?: number },
) {
  const cloudflareSandbox = sandbox.provider === 'cloudflare'
    ? sandbox as CloudflareSandboxClient
    : undefined
  const nativeCloudflareSession = cloudflareSandbox?.native as { createSession?: unknown } | undefined
  if (cloudflareSandbox && typeof nativeCloudflareSession?.createSession === 'function') {
    const remaining = options.deadline ? Math.max(1, options.deadline - Date.now()) : undefined
    const timeout = Math.min(resolveExecRequestTimeout(options.timeout), remaining ?? Number.POSITIVE_INFINITY)
    const sessionPromise = cloudflareSandbox.cloudflare.createSession({
      cwd: options.cwd,
      env: options.env,
      timeout,
    })
    let session: Awaited<typeof sessionPromise>
    try {
      session = await withCloudflareDeadline('createSession', timeout, async () => await sessionPromise)
    }
    catch (error) {
      void sessionPromise.then(async lateSession => {
        await cloudflareSandbox.cloudflare.deleteSession(lateSession.id).catch(() => {})
      }).catch(() => {})
      throw error instanceof SandboxError
        ? error
        : createCloudflareTransportError('createSession', error)
    }
    const deleteSession = async () => {
      const remaining = options.deadline ? Math.max(1, options.deadline - Date.now()) : undefined
      const timeout = Math.min(CLOUDFLARE_CONTROL_PLANE_TIMEOUT_MS, remaining ?? Number.POSITIVE_INFINITY)
      await withCloudflareDeadline(
        'deleteSession',
        timeout,
        async () => await cloudflareSandbox.cloudflare.deleteSession(session.id),
      ).catch(() => {})
    }
    const abortSession = () => void deleteSession()
    try {
      if (options.signal?.aborted) {
        await deleteSession()
        throw createTimeoutError(sandbox.provider, options.timeout || 0)
      }
      options.signal?.addEventListener('abort', abortSession, { once: true })
      let result: Awaited<ReturnType<typeof session.exec>>
      try {
        result = await withCloudflareDeadline('exec', timeout, async () => await session.exec(
          [command, ...args].map(shellQuote).join(' '),
          {
            ...options,
            timeout,
          },
        ))
      }
      catch (error) {
        throw error instanceof SandboxError
          ? error
          : createCloudflareTransportError('exec', error)
      }
      return {
        ok: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.exitCode,
      }
    }
    finally {
      options.signal?.removeEventListener('abort', abortSession)
      await deleteSession()
    }
  }

  return await sandbox.exec(command, args, {
    env: options.env,
    timeout: options.timeout,
  })
}

async function executeSandboxDefinitionOnce<TPayload, TResult>(
  sandbox: SandboxClient,
  definitionName: string,
  definitionOptions: SandboxDefinitionOptions | undefined,
  source: SandboxDefinitionSource,
  payload?: TPayload,
  context?: Record<string, unknown>,
  signal?: AbortSignal,
  deadline?: number,
) {
  const bundle = normalizeSandboxDefinitionBundle(source)

  const files = createExecutionFiles(definitionName)
  const definitionPath = resolveSandboxModulePath(files.baseDir, bundle.entry)
  const inputJson = toJson({ payload, context }, 'payload/context')
  const throwIfAborted = () => {
    if (signal?.aborted)
      throw createTimeoutError(sandbox.provider, definitionOptions?.timeout || 0)
  }

  await sandbox.mkdir(files.baseDir, { recursive: true })
  try {
    throwIfAborted()
    await writeSandboxDefinitionBundle(sandbox, files.baseDir, bundle)
    throwIfAborted()
    await Promise.all([
      sandbox.writeFile(files.entryPath, createEntrySource(definitionPath)),
      sandbox.writeFile(files.inputPath, inputJson),
    ])
    throwIfAborted()

    const launcher = resolveLauncher(sandbox.provider, definitionOptions?.runtime)
    const execArgs = [...launcher.args, files.entryPath, files.inputPath, files.outputPath]

    let outputRaw = ''
    let execution: Awaited<ReturnType<SandboxClient['exec']>> | undefined

    try {
      execution = await executeLauncher(sandbox, launcher.command, execArgs, {
        cwd: files.baseDir,
        deadline,
        env: definitionOptions?.env,
        signal,
        timeout: definitionOptions?.timeout,
      })
      outputRaw = await readExecOutputWithRecovery(sandbox, files.outputPath, execution, definitionOptions?.timeout, execution)
    }
    catch (error) {
      if (error instanceof SandboxError && error.details?.operation === 'createSession')
        throw error

      if (execution) {
        outputRaw = await readExecOutputWithRecovery(sandbox, files.outputPath, error, definitionOptions?.timeout, execution)
      }
      else {
        const recoveredOutput = await recoverExecOutput(sandbox, files.outputPath, error, definitionOptions?.timeout, execution)
        if (recoveredOutput == null)
          throw error

        outputRaw = recoveredOutput
      }
    }

    const output = tryParseSandboxOutput<TResult>(outputRaw)
      || tryParseSandboxOutput(extractSandboxOutputFromExecution(execution) || '')

    if (!output) {
      throw createHandlerError('Sandbox definition output is not valid JSON.', sandbox.provider, {
        output: outputRaw,
        cause: 'Output file was empty or contained incomplete JSON.',
      })
    }

    if (output.ok)
      return output.result as TResult

    throw createHandlerError(output.error?.message || 'Sandbox definition failed.', sandbox.provider, {
      name: output.error?.name,
      stack: output.error?.stack,
      cause: output.error?.cause,
      stdout: execution?.stdout,
      stderr: execution?.stderr,
      exitCode: execution?.code,
    })
  }
  finally {
    if (sandbox.provider === 'cloudflare')
      await sandbox.exec('rm', ['-rf', '--', files.baseDir]).catch(() => {})
  }
}

export async function executeSandboxDefinition<TPayload, TResult>(
  sandbox: SandboxClient,
  definitionName: string,
  definitionOptions: SandboxDefinitionOptions | undefined,
  source: SandboxDefinitionSource,
  payload?: TPayload,
  context?: Record<string, unknown>,
): Promise<TResult> {
  const timeout = definitionOptions?.timeout
  if (typeof timeout !== 'number' || timeout <= 0) {
    return await executeSandboxDefinitionOnce(
      sandbox,
      definitionName,
      definitionOptions,
      source,
      payload,
      context,
    )
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const abortController = new AbortController()
  const deadline = Date.now() + timeout

  try {
    return await Promise.race([
      executeSandboxDefinitionOnce(
        sandbox,
        definitionName,
        definitionOptions,
        source,
        payload,
        context,
        abortController.signal,
        deadline,
      ),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          abortController.abort()
          reject(createTimeoutError(sandbox.provider, timeout))
        }, timeout)
      }),
    ]) as TResult
  }
  finally {
    if (timeoutId)
      clearTimeout(timeoutId)
  }
}
