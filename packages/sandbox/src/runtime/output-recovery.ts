import { CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE, collectCloudflareErrorMessages } from '../internal/shared/cloudflare-retry'
import { sleep } from '../internal/shared/utils'
import { readSandboxErrorInternals, SandboxError } from '../sandbox/errors'
import { isSandboxAbort } from '../sandbox/provider-call'
import { EXEC_STDIO_OUTPUT_MARKER } from './entry-script'

import type { SandboxClient } from '../sandbox/types'
import type { SandboxProvider } from '../sandbox/types/common'
import type { ViteHubErrorDetails } from '@vite-hub/runtime'

const MIN_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS = 20_000
const DEFAULT_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS = 60_000
const MAX_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS = 120_000
const EXEC_OUTPUT_RECOVERY_POLL_MS = 1_000
const EXEC_OUTPUT_PREVIEW_LENGTH = 500

type ExecutionMeta = { stdout?: string, stderr?: string, code?: number | null, meta?: Record<string, unknown> }

function getErrorMessage(error: unknown) {
  if (error instanceof SandboxError)
    return readSandboxErrorInternals(error).message

  if (error instanceof Error)
    return error.message

  if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown, stderr?: unknown, stdout?: unknown }

    if (typeof candidate.message === 'string' && candidate.message)
      return candidate.message
    if (typeof candidate.stderr === 'string' && candidate.stderr)
      return candidate.stderr
    if (typeof candidate.stdout === 'string' && candidate.stdout)
      return candidate.stdout
  }

  if (error === undefined)
    return undefined

  return String(error)
}

function isRecoverableCloudflareExecError(error: unknown) {
  const sandboxError = error instanceof SandboxError ? error : undefined

  if (sandboxError?.details?.provider && sandboxError.details.provider !== 'cloudflare')
    return false

  if (sandboxError?.code === 'SANDBOX_TIMEOUT' || sandboxError?.code === 'SANDBOX_TRANSPORT_ERROR')
    return true

  return CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE.test(collectCloudflareErrorMessages(error))
}

export function createHandlerError(
  message: string,
  provider: SandboxProvider,
  details?: ViteHubErrorDetails,
  cause?: unknown,
) {
  return new SandboxError({
    cause,
    code: 'SANDBOX_HANDLER_ERROR',
    details: { provider, ...details },
    message,
  })
}

export function createTimeoutError(provider: SandboxProvider, timeout: number) {
  return new SandboxError({
    code: 'SANDBOX_TIMEOUT',
    details: { provider, timeoutMs: timeout },
    message: `Sandbox definition timed out after ${timeout}ms.`,
  })
}

export function tryParseSandboxOutput<TResult>(outputRaw: string) {
  if (!outputRaw.trim())
    return null

  try {
    return JSON.parse(outputRaw) as {
      ok?: boolean
      result?: TResult
      error?: { message?: string, name?: string, stack?: string, cause?: string }
    }
  }
  catch {
    return null
  }
}

export function extractSandboxOutputFromExecution(execution?: { stdout?: string, stderr?: string }) {
  const streams = [execution?.stdout, execution?.stderr].filter(Boolean) as string[]

  for (const stream of streams) {
    for (const line of stream.split('\n').reverse()) {
      const markerIndex = line.indexOf(EXEC_STDIO_OUTPUT_MARKER)
      if (markerIndex < 0)
        continue

      return line.slice(markerIndex + EXEC_STDIO_OUTPUT_MARKER.length)
    }
  }

  return null
}

function previewExecutionStream(stream?: string) {
  if (!stream)
    return undefined

  return stream.slice(0, EXEC_OUTPUT_PREVIEW_LENGTH)
}

function getExecutionDiagnostics(execution?: ExecutionMeta) {
  return {
    args:
      Array.isArray(execution?.meta?.args) &&
      execution.meta.args.every((arg) => typeof arg === 'string')
        ? (execution.meta.args as string[])
        : undefined,
    command: typeof execution?.meta?.command === 'string' ? execution.meta.command : undefined,
    cwd: typeof execution?.meta?.cwd === 'string' ? execution.meta.cwd : undefined,
    exitCode: typeof execution?.code === 'undefined' ? undefined : execution.code,
    stderrPreview: previewExecutionStream(execution?.stderr),
    stdoutPreview: previewExecutionStream(execution?.stdout),
  }
}

function getErrorDiagnostics(error: unknown) {
  if (!error || typeof error !== 'object') return {}

  const details = error instanceof SandboxError
    ? readSandboxErrorInternals(error).details
    : 'details' in error ? (error as { details?: Record<string, unknown> }).details : undefined
  if (!details || typeof details !== 'object') return {}

  return {
    args:
      Array.isArray(details.args) && details.args.every((arg) => typeof arg === 'string')
        ? (details.args as string[])
        : undefined,
    command: typeof details.command === 'string' ? details.command : undefined,
    cwd: typeof details.cwd === 'string' ? details.cwd : undefined,
    exitCode: typeof details.exitCode === 'number' || details.exitCode === null ? details.exitCode : undefined,
    spawnErrorCode: typeof details.spawnErrorCode === 'string' ? details.spawnErrorCode : undefined,
    spawnErrorMessage: typeof details.spawnErrorMessage === 'string' ? details.spawnErrorMessage : undefined,
    stderrPreview: typeof details.stderrPreview === 'string' ? details.stderrPreview : undefined,
    stdoutPreview: typeof details.stdoutPreview === 'string' ? details.stdoutPreview : undefined,
  }
}

function resolveExecOutputRecoveryTimeout(timeout?: number) {
  if (!timeout || timeout <= 0)
    return DEFAULT_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS

  return Math.min(
    MAX_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS,
    Math.max(MIN_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS, Math.floor(timeout * 0.1)),
  )
}

function createExecOutputFailure(
  sandbox: SandboxClient,
  outputPath: string,
  error: unknown,
  recoveryTimeout: number,
  execution?: ExecutionMeta,
  details?: ViteHubErrorDetails,
) {
  return createHandlerError(
    'Sandbox definition execution failed before producing an output file.',
    sandbox.provider,
    {
      outputPath,
      recoveryTimeout,
      ...details,
      ...getErrorDiagnostics(error),
      ...getExecutionDiagnostics(execution),
    },
    error,
  )
}

async function waitForExecOutput(
  sandbox: SandboxClient,
  outputPath: string,
  error: unknown,
  timeout: number | undefined,
  execution: ExecutionMeta | undefined,
  shouldAccept: (output: string) => boolean,
) {
  if (isSandboxAbort(error))
    throw error

  const recoveryTimeout = resolveExecOutputRecoveryTimeout(timeout)
  const deadline = Date.now() + recoveryTimeout
  let lastError: unknown = error
  let lastOutput = ''

  while (Date.now() < deadline) {
    try {
      const output = await sandbox.readFile(outputPath)
      lastOutput = output
      if (shouldAccept(output))
        return output
    }
    catch (readError) {
      if (isSandboxAbort(readError))
        throw readError
      lastError = readError
    }

    await sleep(EXEC_OUTPUT_RECOVERY_POLL_MS)
  }

  throw createExecOutputFailure(sandbox, outputPath, error, recoveryTimeout, execution, {
    lastReadError: getErrorMessage(lastError),
    outputPreview: lastOutput.slice(0, EXEC_OUTPUT_PREVIEW_LENGTH) || undefined,
  })
}

async function recoverExecOutput(
  sandbox: SandboxClient,
  outputPath: string,
  error: unknown,
  timeout?: number,
  execution?: ExecutionMeta,
) {
  if (isSandboxAbort(error))
    throw error

  if (sandbox.provider !== 'cloudflare' || !isRecoverableCloudflareExecError(error))
    return null

  return await waitForExecOutput(
    sandbox,
    outputPath,
    error,
    timeout,
    execution,
    output => !!tryParseSandboxOutput(output),
  )
}

async function waitForCloudflareOutput(
  sandbox: SandboxClient,
  outputPath: string,
  error: unknown,
  timeout?: number,
  execution?: ExecutionMeta,
) {
  const recoveryTimeout = resolveExecOutputRecoveryTimeout(timeout)

  if (sandbox.provider !== 'cloudflare')
    throw createExecOutputFailure(sandbox, outputPath, error, recoveryTimeout, execution)

  return await waitForExecOutput(
    sandbox,
    outputPath,
    error,
    timeout,
    execution,
    output => !!tryParseSandboxOutput(output),
  )
}

export async function readExecOutputWithRecovery(
  sandbox: SandboxClient,
  outputPath: string,
  error: unknown,
  timeout?: number,
  execution?: ExecutionMeta,
) {
  if (isSandboxAbort(error))
    throw error

  const executionOutput = extractSandboxOutputFromExecution(execution)
    || extractSandboxOutputFromExecution(error as { stdout?: string, stderr?: string } | undefined)
  if (executionOutput)
    return executionOutput

  try {
    const output = await sandbox.readFile(outputPath)
    if (tryParseSandboxOutput(output))
      return output
  }
  catch (readError) {
    if (isSandboxAbort(readError))
      throw readError
    return await waitForCloudflareOutput(sandbox, outputPath, error, timeout, execution)
  }

  return await waitForCloudflareOutput(sandbox, outputPath, error, timeout, execution)
}

export { recoverExecOutput }
