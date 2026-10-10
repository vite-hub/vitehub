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
    if (error && typeof error === 'object' && 'code' in error && String((error as { code?: unknown }).code).startsWith('SANDBOX_'))
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
      throw createTimeoutError(sandbox.provider, definitionOptions?.timeout || 0)
  }

  await sandbox.mkdir(files.baseDir, { recursive: true })
  try {
    throwIfAborted()
    let inputJson = bundle.project
      ? toJson(await encodeSandboxValue(
          sandbox,
          { payload, context },
          files.inputAssetsDir,
          'payload/context',
          signal,
          transferLimits,
        ), 'payload/context', maxInputBytes)
      : undefined
    const prepared = await prepareSandboxDefinition(sandbox, bundle, files.baseDir, {
      signal,
      timeout: definitionOptions?.timeout,
    })
    inputJson ||= toJson(await encodeSandboxValue(
      sandbox,
      { payload, context },
      files.inputAssetsDir,
      'payload/context',
      signal,
      transferLimits,
    ), 'payload/context', maxInputBytes)
    const definitionPath = resolveSandboxModulePath(prepared.directory, bundle.entry)
    throwIfAborted()
    await Promise.all([
      sandbox.writeFile(files.entryPath, createEntrySource(definitionPath, bundle.execution)),
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
      outputRaw = await readExecOutputWithRecovery(sandbox, files.outputPath, execution, definitionOptions?.timeout, execution, maxOutputBytes)
    }
    catch (error) {
      if (readSandboxErrorMetadata(error)?.details?.operation === 'createSession')
        throw error

      if (execution) {
        outputRaw = await readExecOutputWithRecovery(sandbox, files.outputPath, error, definitionOptions?.timeout, execution, maxOutputBytes)
      }
      else {
        const recoveredOutput = await recoverExecOutput(sandbox, files.outputPath, error, definitionOptions?.timeout, execution, maxOutputBytes)
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
): Promise<unknown> {
  const timeout = definitionOptions?.timeout
  if (timeout === undefined || timeout <= 0) {
    return await executeSandboxDefinitionOnce(
      sandbox,
      definitionName,
      definitionOptions,
      source,
      payload,
      context,
      undefined,
      lifecycle,
    )
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const abortController = new AbortController()

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
        lifecycle,
      ),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          const timeoutError = createTimeoutError(sandbox.provider, timeout)
          abortController.abort(timeoutError)
          reject(timeoutError)
        }, timeout)
      }),
    ])
  }
  finally {
    if (timeoutId)
      clearTimeout(timeoutId)
  }
}
