import { isRetriableCloudflareError } from '../internal/shared/cloudflare-retry'
import { sleep } from '../internal/shared/sleep'
import type { SandboxClient } from '../sandbox/types'
import {
  createHandlerError,
  extractSandboxOutputFromExecution,
  getErrorDiagnostics,
  getErrorMessage,
  getExecutionDiagnostics,
  tryParseSandboxOutput,
} from './execute-output'

const MIN_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS = 20_000
const DEFAULT_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS = 60_000
const MAX_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS = 120_000
const EXEC_OUTPUT_RECOVERY_POLL_MS = 1_000

export function resolveExecOutputRecoveryTimeout(timeout?: number) {
  if (!timeout || timeout <= 0)
    return DEFAULT_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS

  return Math.min(
    MAX_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS,
    Math.max(MIN_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS, Math.floor(timeout * 0.1)),
  )
}

function isRecoverableCloudflareExecError(error: unknown) {
  return isRetriableCloudflareError(error, {
    allowedCodes: ['TIMEOUT', 'SANDBOX_TRANSPORT_ERROR'],
  })
}

export async function recoverExecOutput(
  sandbox: SandboxClient,
  outputPath: string,
  error: unknown,
  timeout?: number,
  execution?: { stdout?: string, stderr?: string, code?: number | null },
) {
  if (sandbox.provider !== 'cloudflare' || !isRecoverableCloudflareExecError(error))
    return null

  const recoveryTimeout = resolveExecOutputRecoveryTimeout(timeout)
  const deadline = Date.now() + recoveryTimeout
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      return await sandbox.readFile(outputPath)
    }
    catch (readError) {
      lastError = readError
      await sleep(EXEC_OUTPUT_RECOVERY_POLL_MS)
    }
  }

  throw createHandlerError('Sandbox definition execution failed before producing an output file.', sandbox.provider, {
    outputPath,
    cause: getErrorMessage(error),
    lastReadError: getErrorMessage(lastError),
    recoveryTimeout,
    ...getErrorDiagnostics(error),
    ...getExecutionDiagnostics(execution),
  })
}

async function waitForCloudflareOutput(
  sandbox: SandboxClient,
  outputPath: string,
  error: unknown,
  timeout?: number,
  execution?: { stdout?: string, stderr?: string, code?: number | null },
) {
  if (sandbox.provider !== 'cloudflare')
    throw error

  const recoveryTimeout = resolveExecOutputRecoveryTimeout(timeout)
  const deadline = Date.now() + recoveryTimeout
  let lastError: unknown = error
  let lastOutput = ''

  while (Date.now() < deadline) {
    try {
      const output = await sandbox.readFile(outputPath)
      if (tryParseSandboxOutput(output))
        return output
      lastOutput = output
    }
    catch (readError) {
      lastError = readError
    }

    await sleep(EXEC_OUTPUT_RECOVERY_POLL_MS)
  }

  throw createHandlerError('Sandbox definition execution failed before producing an output file.', sandbox.provider, {
    outputPath,
    cause: getErrorMessage(error),
    lastReadError: getErrorMessage(lastError),
    recoveryTimeout,
    outputPreview: lastOutput.slice(0, 500),
    ...getErrorDiagnostics(error),
    ...getExecutionDiagnostics(execution),
  })
}

export async function readExecOutputWithRecovery(
  sandbox: SandboxClient,
  outputPath: string,
  error: unknown,
  timeout?: number,
  execution?: { stdout?: string, stderr?: string, code?: number | null },
) {
  const executionOutput = extractSandboxOutputFromExecution(execution)
    || extractSandboxOutputFromExecution(error as { stdout?: string, stderr?: string } | undefined)
  if (executionOutput)
    return executionOutput

  try {
    const output = await sandbox.readFile(outputPath)
    if (tryParseSandboxOutput(output))
      return output
  }
  catch {
    return await waitForCloudflareOutput(sandbox, outputPath, error, timeout, execution)
  }

  return await waitForCloudflareOutput(sandbox, outputPath, error, timeout, execution)
}
