import { decodeSandboxTaskValue, encodeSandboxTaskValue } from './binary-sidecars'
import { sandboxTaskError } from '../sandbox-task/errors'
import { readSandboxTaskErrorMetadata } from './error-normalization'
import { createEntrySource } from './entry-script'
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

export interface SandboxTaskDefinitionExecutionLifecycle {
  onExecution?: (execution: Promise<unknown>) => void
  onHandlerStart?: () => void
}

function toJson(value: unknown, label: string) {
  try {
    return JSON.stringify(value)
  }
  catch (error) {
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
) {
  const bundle = normalizeSandboxTaskDefinitionBundle(source)

  const files = createExecutionFiles(definitionName)
  const throwIfAborted = () => {
    if (signal?.aborted)
      throw signal.reason ?? new DOMException('The Sandbox invocation was aborted.', 'AbortError')
  }

  await sandbox.mkdir(files.baseDir, { recursive: true, signal })
  try {
    throwIfAborted()
    let inputJson = bundle.project
      ? toJson(await encodeSandboxTaskValue(
          sandbox,
          { payload, context },
          files.inputAssetsDir,
          'payload/context',
          signal,
        ), 'payload/context')
      : undefined
    const prepared = await prepareSandboxTaskDefinition(sandbox, bundle, files.baseDir, {
      signal,
      timeout: definitionOptions?.timeout,
    })
    inputJson ||= toJson(await encodeSandboxTaskValue(
      sandbox,
      { payload, context },
      files.inputAssetsDir,
      'payload/context',
      signal,
    ), 'payload/context')
    const definitionPath = resolveSandboxTaskModulePath(prepared.directory, bundle.entry)
    throwIfAborted()
    await Promise.all([
      sandbox.writeFile(files.entryPath, createEntrySource(definitionPath, bundle.execution), { signal }),
      sandbox.writeFile(files.inputPath, inputJson, { signal }),
    ])
    throwIfAborted()

    const execArgs = ['-e', 'import(process.argv[1])', files.entryPath, files.inputPath, files.outputPath]

    let outputRaw = ''
    let execution: Awaited<ReturnType<TaskSandbox['exec']>> | undefined

    try {
      lifecycle?.onHandlerStart?.()
      execution = await sandbox.exec('node', execArgs, {
        cwd: prepared.cwd,
        env: definitionOptions?.env,
        signal,
        timeout: definitionOptions?.timeout,
      })
      outputRaw = await readExecOutputWithRecovery(sandbox, files.outputPath, execution, definitionOptions?.timeout, execution, signal)
    }
    catch (error) {
      throwIfAborted()
      if (readSandboxTaskErrorMetadata(error)?.details?.operation === 'createSession')
        throw error

      if (execution) {
        outputRaw = await readExecOutputWithRecovery(sandbox, files.outputPath, error, definitionOptions?.timeout, execution, signal)
      }
      else {
        const recoveredOutput = await recoverExecOutput(sandbox, files.outputPath, error, definitionOptions?.timeout, execution, signal)
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
      return await decodeSandboxTaskValue(sandbox, output.result, files.outputAssetsDir, 'result', signal)

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
  finally {
    if (sandbox.provider === 'cloudflare')
      await sandbox.exec('rm', ['-rf', '--', files.baseDir]).catch(() => {})
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
