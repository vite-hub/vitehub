import {
  decodeSandboxValue,
  DEFAULT_SANDBOX_TRANSFER_LIMITS,
  encodeSandboxValue,
  type SandboxTransferLimits,
} from './binary-sidecars'
import { sandboxError } from '../sandbox/errors'
import { readSandboxErrorMetadata } from './error-normalization'
import { createEntrySource } from './entry-script'
import { prepareSandboxDefinition } from './definition-preparation'
import {
  createExecutionFiles,
  normalizeSandboxDefinitionBundle,
  resolveSandboxModulePath,
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
import type { SandboxExecutionBox } from './execution-box'

import type { SandboxDefinitionOptions, SandboxTransferOptions } from '../module-types'

export interface SandboxDefinitionExecutionLifecycle {
  onExecution?: (execution: Promise<unknown>) => void
  onHandlerStart?: () => void
}

const DEFAULT_TRANSFER_BYTES = 4 * 1024 * 1024

function resolveTransferLimits(options?: SandboxTransferOptions): SandboxTransferLimits {
  return {
    maxDepth: options?.maxDepth ?? DEFAULT_SANDBOX_TRANSFER_LIMITS.maxDepth,
    maxSidecars: options?.maxSidecars ?? DEFAULT_SANDBOX_TRANSFER_LIMITS.maxSidecars,
    maxSidecarBytes: options?.maxSidecarBytes ?? DEFAULT_SANDBOX_TRANSFER_LIMITS.maxSidecarBytes,
  }
}

function assertJsonBytes(value: string, label: string, maximum: number) {
  const bytes = new TextEncoder().encode(value).byteLength
  if (bytes > maximum) {
    throw sandboxError(`Sandbox ${label} exceeds its maxBytes limit (${bytes} > ${maximum}).`, {
      code: 'SANDBOX_TRANSFER_LIMIT',
      details: { label, limit: label === 'result' ? 'maxOutputBytes' : 'maxInputBytes', value: bytes, maximum },
    })
  }
}

function toJson(value: unknown, label: string, maximum: number) {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined)
      throw new TypeError('JSON.stringify returned undefined')
    assertJsonBytes(serialized, label, maximum)
    return serialized
  }
  catch (error) {
    if (readSandboxErrorMetadata(error)?.code?.startsWith('SANDBOX_'))
      throw error
    throw sandboxError(`Sandbox ${label} must be JSON-serializable.`, {
      code: 'SANDBOX_SERIALIZATION_ERROR',
      details: { label },
      cause: error,
    })
  }
}

async function executeSandboxDefinitionOnce<TPayload>(
  sandbox: SandboxExecutionBox,
  definitionName: string,
  definitionOptions: SandboxDefinitionOptions | undefined,
  source: SandboxDefinitionSource,
  payload?: TPayload,
  context?: Record<string, unknown>,
  signal?: AbortSignal,
  lifecycle?: SandboxDefinitionExecutionLifecycle,
) {
  const bundle = normalizeSandboxDefinitionBundle(source)
  const transferLimits = resolveTransferLimits(definitionOptions?.transfer)
  const maxInputBytes = definitionOptions?.transfer?.maxInputBytes ?? DEFAULT_TRANSFER_BYTES
  const maxOutputBytes = definitionOptions?.transfer?.maxOutputBytes ?? DEFAULT_TRANSFER_BYTES

  const files = createExecutionFiles(definitionName)
  const throwIfAborted = () => {
    if (signal?.aborted)
      throw signal.reason ?? new DOMException('The Sandbox invocation was aborted.', 'AbortError')
  }

  await sandbox.mkdir(files.baseDir, { recursive: true, signal })
  try {
    throwIfAborted()
    let inputJson: string | undefined
    if (bundle.project) {
      const encoded = await encodeSandboxValue(
        sandbox,
        { payload, context },
        files.inputAssetsDir,
        'payload/context',
        signal,
        transferLimits,
      )
      inputJson = toJson(encoded.value, 'payload/context', maxInputBytes)
      await encoded.writeSidecars()
    }
    const prepared = await prepareSandboxDefinition(sandbox, bundle, files.baseDir, {
      signal,
      timeout: definitionOptions?.timeout,
    })
    if (!inputJson) {
      const encoded = await encodeSandboxValue(
        sandbox,
        { payload, context },
        files.inputAssetsDir,
        'payload/context',
        signal,
        transferLimits,
      )
      inputJson = toJson(encoded.value, 'payload/context', maxInputBytes)
      await encoded.writeSidecars()
    }
    const definitionPath = resolveSandboxModulePath(prepared.directory, bundle.entry)
    throwIfAborted()
    await Promise.all([
      sandbox.writeFile(files.entryPath, createEntrySource(definitionPath, bundle.execution, transferLimits)),
      sandbox.writeFile(files.inputPath, inputJson),
    ])
    throwIfAborted()

    const execArgs = ['-e', 'import(process.argv[1])', files.entryPath, files.inputPath, files.outputPath]

    let outputRaw = ''
    let execution: Awaited<ReturnType<SandboxExecutionBox['exec']>> | undefined

    try {
      lifecycle?.onHandlerStart?.()
      execution = await sandbox.exec('node', execArgs, {
        cwd: prepared.cwd,
        env: definitionOptions?.env,
        signal,
        timeout: definitionOptions?.timeout,
      })
      outputRaw = await readExecOutputWithRecovery(sandbox, files.outputPath, execution, definitionOptions?.timeout, execution, maxOutputBytes, signal)
    }
    catch (error) {
      throwIfAborted()
      if (readSandboxErrorMetadata(error)?.details?.operation === 'createSession')
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

    assertJsonBytes(outputRaw, 'result', maxOutputBytes)

    const output = tryParseSandboxOutput<unknown>(outputRaw)
      || tryParseSandboxOutput(extractSandboxOutputFromExecution(execution) || '')

    if (!output) {
      throw createHandlerError('Sandbox definition output is not valid JSON.', sandbox.provider, {
        output: outputRaw,
        cause: 'Output file was empty or contained incomplete JSON.',
      })
    }

    if (output.ok)
      return await decodeSandboxValue(sandbox, output.result, files.outputAssetsDir, 'result', transferLimits)

    if (output.error?.code === 'SANDBOX_TRANSFER_LIMIT')
      throw sandboxError(output.error.message || 'Sandbox result exceeds its transfer limit.', { code: 'SANDBOX_TRANSFER_LIMIT' })

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

export async function executeSandboxDefinition<TPayload>(
  sandbox: SandboxExecutionBox,
  definitionName: string,
  definitionOptions: SandboxDefinitionOptions | undefined,
  source: SandboxDefinitionSource,
  payload?: TPayload,
  context?: Record<string, unknown>,
  lifecycle?: SandboxDefinitionExecutionLifecycle,
  externalSignal?: AbortSignal,
): Promise<unknown> {
  const timeout = definitionOptions?.timeout
  const execute = (signal?: AbortSignal) => {
    const execution = executeSandboxDefinitionOnce(sandbox, definitionName, definitionOptions, source, payload, context, signal, lifecycle)
    lifecycle?.onExecution?.(execution)
    return execution
  }
  if ((timeout === undefined || timeout <= 0) && !externalSignal) {
    return await execute()
  }

  externalSignal?.throwIfAborted()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const abortController = new AbortController()
  const signal = timeout === undefined || timeout <= 0
    ? externalSignal!
    : externalSignal
      ? AbortSignal.any([externalSignal, abortController.signal])
      : abortController.signal
  let externalAbort: (() => void) | undefined

  try {
    const races: Array<Promise<unknown>> = [execute(signal)]
    if (externalSignal) {
      races.push(new Promise<never>((_, reject) => {
        externalAbort = () => reject(externalSignal.reason ?? new DOMException('The Sandbox invocation was aborted.', 'AbortError'))
        externalSignal.addEventListener('abort', externalAbort, { once: true })
      }))
    }
    if (timeout !== undefined && timeout > 0) {
      races.push(new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          const timeoutError = createTimeoutError(sandbox.provider, timeout)
          abortController.abort(timeoutError)
          reject(timeoutError)
        }, timeout)
      }))
    }
    return await Promise.race(races)
  }
  finally {
    if (timeoutId)
      clearTimeout(timeoutId)
    if (externalAbort)
      externalSignal?.removeEventListener('abort', externalAbort)
  }
}
