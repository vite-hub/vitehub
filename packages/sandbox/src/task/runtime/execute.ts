import {
  assertSandboxTaskTransferBytes,
  decodeSandboxTaskValue,
  DEFAULT_SANDBOX_TASK_TRANSFER_BYTES,
  DEFAULT_SANDBOX_TASK_TRANSFER_LIMITS,
  encodeSandboxTaskValueStaged,
} from './binary-sidecars'
import { isTrustedHostReservedCommandEnvironmentKey } from '../../internal/trusted-host-environment'
import { isSandboxTaskError, sandboxTaskError } from '../sandbox-task/errors'
import { combineSandboxTaskErrors, readSandboxTaskErrorMetadata } from './error-normalization'
import { createEntrySource } from './entry-script.injected'
import { prepareSandboxTaskDefinition } from './definition-preparation'
import {
  createExecutionFiles,
  normalizeSandboxTaskDefinitionBundle,
  resolveSandboxTaskModulePath,
  type SandboxTaskDefinitionSource,
} from './execution-files'
import {
  createHandlerError,
  createTimeoutError,
  extractSandboxTaskOutputFromExecution,
  readExecOutputWithRecovery,
  recoverExecOutput,
  tryParseSandboxTaskOutput,
} from './output-recovery'
import type { TaskSandbox } from './task-sandbox'

import type { SandboxTaskDefinitionOptions } from '../module-types'

const SANDBOX_CLEANUP_GRACE_MS = 1_000

export interface SandboxTaskDefinitionExecutionLifecycle {
  onExecution?: (execution: Promise<unknown>) => void
  /** Called before a command that must not run twice: the package install, the project publish, and the handler. */
  onCommandStart?: () => void
}

function toJson(value: unknown, label: string, maxInputBytes: number) {
  try {
    const json = JSON.stringify(value)
    assertSandboxTaskTransferBytes(json, label, 'maxInputBytes', maxInputBytes)
    return json
  }
  catch (error) {
    if (isSandboxTaskError(error))
      throw error
    throw sandboxTaskError(`Sandbox ${label} must be JSON-serializable.`, {
      code: 'SANDBOX_TASK_SERIALIZATION_ERROR',
      details: { label },
      cause: error,
    })
  }
}

async function executeSandboxTaskDefinitionOnce<TPayload>(
  sandbox: TaskSandbox,
  definitionName: string,
  definitionOptions: SandboxTaskDefinitionOptions | undefined,
  source: SandboxTaskDefinitionSource,
  payload?: TPayload,
  context?: Record<string, unknown>,
  signal?: AbortSignal,
  lifecycle?: SandboxTaskDefinitionExecutionLifecycle,
  deadline?: number,
) {
  const bundle = normalizeSandboxTaskDefinitionBundle(source)

  const files = createExecutionFiles(definitionName, sandbox.tempDir)
  const transfer = definitionOptions?.transfer
  const transferLimits = {
    maxDepth: transfer?.maxDepth ?? DEFAULT_SANDBOX_TASK_TRANSFER_LIMITS.maxDepth,
    maxSidecars: transfer?.maxSidecars ?? DEFAULT_SANDBOX_TASK_TRANSFER_LIMITS.maxSidecars,
    maxSidecarBytes: transfer?.maxSidecarBytes ?? DEFAULT_SANDBOX_TASK_TRANSFER_LIMITS.maxSidecarBytes,
  }
  const maxInputBytes = transfer?.maxInputBytes ?? DEFAULT_SANDBOX_TASK_TRANSFER_BYTES
  const maxOutputBytes = transfer?.maxOutputBytes ?? DEFAULT_SANDBOX_TASK_TRANSFER_BYTES
  let failure: { error: unknown } | undefined
  const throwIfAborted = () => {
    if (signal?.aborted)
      throw signal.reason ?? new DOMException('The Sandbox invocation was aborted.', 'AbortError')
  }

  const encodeInput = async () => {
    const encoded = await encodeSandboxTaskValueStaged(
      sandbox,
      { payload, context },
      files.inputAssetsDir,
      'payload/context',
      signal,
      transferLimits,
      -1,
    )
    const json = toJson(encoded.value, 'payload/context', maxInputBytes)
    await encoded.writeSidecars()
    return json
  }

  try {
    await sandbox.mkdir(files.baseDir, { recursive: true, signal })
    throwIfAborted()
    let inputJson = bundle.project ? await encodeInput() : undefined
    const prepared = await prepareSandboxTaskDefinition(sandbox, bundle, files.baseDir, {
      onCommandStart: lifecycle?.onCommandStart,
      signal,
      timeout: definitionOptions?.timeout,
    })
    inputJson ||= await encodeInput()
    const definitionPath = resolveSandboxTaskModulePath(prepared.directory, bundle.entry)
    const local = sandbox.provider === 'local'
    let env = definitionOptions?.env
    let entryEnvironment: Record<string, string> | undefined
    if (local && env) {
      const entries = Object.entries(env)
      entryEnvironment = Object.fromEntries(entries.filter(([name]) => isTrustedHostReservedCommandEnvironmentKey(name)))
      env = Object.fromEntries(entries.filter(([name]) => !isTrustedHostReservedCommandEnvironmentKey(name)))
    }
    throwIfAborted()
    await Promise.all([
      sandbox.writeFile(files.entryPath, createEntrySource(definitionPath, bundle.execution, entryEnvironment, { ...transferLimits, maxOutputBytes }), { signal }),
      sandbox.writeFile(files.inputPath, inputJson, { signal }),
    ])
    throwIfAborted()

    const execArgs = local
      ? [files.entryPath, files.inputPath, files.outputPath]
      : ['-e', 'import(process.argv[1])', files.entryPath, files.inputPath, files.outputPath]

    let outputRaw = ''
    let execution: Awaited<ReturnType<TaskSandbox['exec']>> | undefined

    try {
      lifecycle?.onCommandStart?.()
      execution = await sandbox.exec('node', execArgs, {
        cwd: prepared.cwd,
        env,
        signal,
        timeout: definitionOptions?.timeout,
      })
      outputRaw = await readExecOutputWithRecovery(sandbox, files.outputPath, execution, definitionOptions?.timeout, execution, maxOutputBytes, signal)
    }
    catch (error) {
      throwIfAborted()
      if (readSandboxTaskErrorMetadata(error)?.details?.operation === 'createSession')
        throw error

      if (execution) {
        outputRaw = await readExecOutputWithRecovery(sandbox, files.outputPath, error, definitionOptions?.timeout, execution, maxOutputBytes, signal)
      }
      else {
        const recoveredOutput = await recoverExecOutput(sandbox, files.outputPath, error, definitionOptions?.timeout, execution, maxOutputBytes, signal)
        if (recoveredOutput == null)
          throw error

        outputRaw = recoveredOutput
      }
    }

    const output = tryParseSandboxTaskOutput<unknown>(outputRaw)
      || tryParseSandboxTaskOutput(extractSandboxTaskOutputFromExecution(execution) || '')

    if (!output) {
      throw createHandlerError('Sandbox Task Definition output is not valid JSON.', sandbox.provider, {
        output: outputRaw,
        cause: 'Output file was empty or contained incomplete JSON.',
      })
    }

    if (output.ok)
      return await decodeSandboxTaskValue(sandbox, output.result, files.outputAssetsDir, 'result', signal, transferLimits)

    if (output.error?.code === 'SANDBOX_TASK_TRANSFER_LIMIT') {
      throw sandboxTaskError(output.error.message || 'Sandbox result exceeds its transfer limit.', {
        code: 'SANDBOX_TASK_TRANSFER_LIMIT',
        provider: sandbox.provider,
      })
    }

    if (output.error?.code === 'SANDBOX_TASK_SERIALIZATION_ERROR') {
      throw sandboxTaskError(output.error.message || 'Sandbox result must be JSON-serializable.', {
        code: 'SANDBOX_TASK_SERIALIZATION_ERROR',
        provider: sandbox.provider,
        cause: output.error.cause,
      })
    }

    throw createHandlerError(output.error?.message || 'Sandbox Task Definition failed.', sandbox.provider, {
      name: output.error?.name,
      stack: output.error?.stack,
      cause: output.error?.cause,
      stdout: execution?.stdout,
      stderr: execution?.stderr,
      exitCode: execution?.code,
    })
  }
  catch (error) {
    failure = { error }
    throw error
  }
  finally {
    if (sandbox.provider === 'cloudflare' && !sandbox.closesAfterRun) {
      const cleanupTimeout = deadline === undefined ? undefined : SANDBOX_CLEANUP_GRACE_MS
      const cleanupOptions = cleanupTimeout === undefined ? undefined : { timeout: cleanupTimeout }
      try {
        const cleanup = await sandbox.exec('rm', ['-rf', '--', files.baseDir], cleanupOptions).catch((error: unknown) => {
          throw sandboxTaskError('Sandbox invocation cleanup failed.', {
            provider: sandbox.provider,
            cause: error,
          })
        })
        if (!cleanup.ok || cleanup.code !== 0) {
          throw sandboxTaskError('Sandbox invocation cleanup failed.', {
            provider: sandbox.provider,
            details: { operation: 'cleanup', exitCode: cleanup.code },
            cause: cleanup,
          })
        }
      }
      catch (cleanupError) {
        if (failure)
          throw combineSandboxTaskErrors(failure.error, cleanupError)
        throw cleanupError
      }
    }
  }
}

export async function executeSandboxTaskDefinition<TPayload>(
  sandbox: TaskSandbox,
  definitionName: string,
  definitionOptions: SandboxTaskDefinitionOptions | undefined,
  source: SandboxTaskDefinitionSource,
  payload?: TPayload,
  context?: Record<string, unknown>,
  lifecycle?: SandboxTaskDefinitionExecutionLifecycle,
  externalSignal?: AbortSignal,
): Promise<unknown> {
  const timeout = definitionOptions?.timeout
  const execute = (signal?: AbortSignal) => {
    const execution = executeSandboxTaskDefinitionOnce(sandbox, definitionName, definitionOptions, source, payload, context, signal, lifecycle)
    lifecycle?.onExecution?.(execution)
    return execution
  }
  if ((timeout === undefined || timeout <= 0) && !externalSignal) {
    return await execute()
  }

  externalSignal?.throwIfAborted()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const abortController = new AbortController()
  const deadline = timeout === undefined || timeout <= 0 ? undefined : Date.now() + timeout
  let timedOut = false
  let timeoutError: ReturnType<typeof createTimeoutError> | undefined
  const signal = timeout === undefined || timeout <= 0
    ? externalSignal!
    : externalSignal
      ? AbortSignal.any([externalSignal, abortController.signal])
      : abortController.signal
  let externalAbort: (() => void) | undefined
  let execution: Promise<unknown> | undefined

  try {
    const currentExecution = execution = executeSandboxTaskDefinitionOnce(
      sandbox,
      definitionName,
      definitionOptions,
      source,
      payload,
      context,
      signal,
      lifecycle,
      deadline,
    )
    lifecycle?.onExecution?.(currentExecution)
    const races: Array<Promise<unknown>> = [currentExecution]
    if (externalSignal) {
      races.push(new Promise<never>((_, reject) => {
        externalAbort = () => reject(externalSignal.reason ?? new DOMException('The Sandbox invocation was aborted.', 'AbortError'))
        externalSignal.addEventListener('abort', externalAbort, { once: true })
      }))
    }
    if (timeout !== undefined && timeout > 0) {
      races.push(new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timeoutError = createTimeoutError(sandbox.provider, timeout)
          timedOut = true
          abortController.abort(timeoutError)
          reject(timeoutError)
        }, timeout)
      }))
    }
    return await Promise.race(races)
  }
  catch (error) {
    if (timedOut) {
      await execution!.catch((executionError: unknown) => {
        if (executionError !== timeoutError) {
          throw sandboxTaskError(timeoutError!.message, {
            code: 'SANDBOX_TASK_TIMEOUT',
            details: timeoutError!.details,
            cause: executionError,
          })
        }
      })
      throw timeoutError ?? error
    }
    throw error
  }
  finally {
    if (timeoutId)
      clearTimeout(timeoutId)
    if (externalAbort)
      externalSignal?.removeEventListener('abort', externalAbort)
  }
}
