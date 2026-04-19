import { SandboxError } from '../sandbox/errors'

export const EXEC_STDIO_OUTPUT_MARKER = '__VITEHUB_OUTPUT__'

export function createHandlerError(message: string, provider: string, details?: Record<string, unknown>) {
  return new SandboxError(message, {
    code: 'SANDBOX_HANDLER_ERROR',
    provider,
    details,
  })
}

export function createTimeoutError(provider: string, timeout: number) {
  return new SandboxError(`Sandbox definition timed out after ${timeout}ms.`, {
    code: 'TIMEOUT',
    provider,
    details: { timeout },
  })
}

export function getErrorMessage(error: unknown) {
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

  return stream.slice(0, 500)
}

export function getExecutionDiagnostics(execution?: { stdout?: string, stderr?: string, code?: number | null, meta?: Record<string, unknown> }) {
  return {
    args: Array.isArray(execution?.meta?.args) ? execution?.meta?.args : undefined,
    command: typeof execution?.meta?.command === 'string' ? execution.meta.command : undefined,
    cwd: typeof execution?.meta?.cwd === 'string' ? execution.meta.cwd : undefined,
    exitCode: typeof execution?.code === 'undefined' ? undefined : execution.code,
    stderrPreview: previewExecutionStream(execution?.stderr),
    stdoutPreview: previewExecutionStream(execution?.stdout),
  }
}

export function getErrorDiagnostics(error: unknown) {
  if (!error || typeof error !== 'object' || !('details' in error))
    return {}

  const details = (error as { details?: Record<string, unknown> }).details
  if (!details || typeof details !== 'object')
    return {}

  return {
    args: Array.isArray(details.args) ? details.args : undefined,
    command: typeof details.command === 'string' ? details.command : undefined,
    cwd: typeof details.cwd === 'string' ? details.cwd : undefined,
    exitCode: typeof details.exitCode === 'number' || details.exitCode === null ? details.exitCode : undefined,
    spawnErrorCode: typeof details.spawnErrorCode === 'string' ? details.spawnErrorCode : undefined,
    spawnErrorMessage: typeof details.spawnErrorMessage === 'string' ? details.spawnErrorMessage : undefined,
    stderrPreview: typeof details.stderrPreview === 'string' ? details.stderrPreview : undefined,
    stdoutPreview: typeof details.stdoutPreview === 'string' ? details.stdoutPreview : undefined,
  }
}
