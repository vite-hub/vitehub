import { decodeSandboxValue, encodeSandboxValue } from './binary-sidecars'
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

import type { SandboxDefinitionOptions } from '../module-types'

export interface SandboxDefinitionExecutionLifecycle {
  onHandlerStart?: () => void
}

function toJson(value: unknown, label: string) {
  try {
    return JSON.stringify(value)
  }
  catch (error) {
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

  const files = createExecutionFiles(definitionName)
  const throwIfAborted = () => {
    if (signal?.aborted)
      throw signal.reason ?? new DOMException('The Sandbox invocation was aborted.', 'AbortError')
  }

  await sandbox.mkdir(files.baseDir, { recursive: true, signal })
  try {
    throwIfAborted()
    let inputJson = bundle.project
      ? toJson(await encodeSandboxValue(
          sandbox,
          { payload, context },
          files.inputAssetsDir,
          'payload/context',
          signal,
        ), 'payload/context')
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
    ), 'payload/context')
    const definitionPath = resolveSandboxModulePath(prepared.directory, bundle.entry)
    throwIfAborted()
    await Promise.all([
      sandbox.writeFile(files.entryPath, createEntrySource(definitionPath, bundle.execution), { signal }),
      sandbox.writeFile(files.inputPath, inputJson, { signal }),
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
      outputRaw = await readExecOutputWithRecovery(sandbox, files.outputPath, execution, definitionOptions?.timeout, execution)
    }
    catch (error) {
      throwIfAborted()
      if (readSandboxErrorMetadata(error)?.details?.operation === 'createSession')
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

    const output = tryParseSandboxOutput<unknown>(outputRaw)
      || tryParseSandboxOutput(extractSandboxOutputFromExecution(execution) || '')

    if (!output) {
      throw createHandlerError('Sandbox definition output is not valid JSON.', sandbox.provider, {
        output: outputRaw,
        cause: 'Output file was empty or contained incomplete JSON.',
      })
    }

    if (output.ok)
      return await decodeSandboxValue(sandbox, output.result, files.outputAssetsDir, 'result')

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
  if ((timeout === undefined || timeout <= 0) && !externalSignal) {
    return await executeSandboxDefinitionOnce(
      sandbox,
      definitionName,
      definitionOptions,
      source,
      payload,
      context,
      externalSignal,
      lifecycle,
    )
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
    const races: Array<Promise<unknown>> = [executeSandboxDefinitionOnce(
      sandbox,
      definitionName,
      definitionOptions,
      source,
      payload,
      context,
      signal,
      lifecycle,
    )]
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
