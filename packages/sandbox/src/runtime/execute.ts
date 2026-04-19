import { dirname } from 'pathe'
import { CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE } from '../internal/shared/cloudflare-retry'
import { SandboxError } from '../sandbox/errors'
import type { SandboxClient } from '../sandbox/types'
import type { SandboxDefinitionBundle, SandboxDefinitionOptions, SandboxDefinitionRuntime } from '../module-types'

const defaultNodeLauncher = 'import(process.argv[1]).then((mod) => mod.main(process.argv.slice(2)))'
const MIN_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS = 20_000
const DEFAULT_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS = 60_000
const MAX_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS = 120_000
const EXEC_OUTPUT_RECOVERY_POLL_MS = 1_000
const EXEC_STDIO_OUTPUT_MARKER = '__VITEHUB_OUTPUT__'
const EXEC_OUTPUT_PREVIEW_LENGTH = 500
const DEFAULT_DEFINITION_ENTRY = 'definition.js'

type SandboxDefinitionSource = SandboxDefinitionBundle | string

function normalizeSandboxDefinitionBundle(source: SandboxDefinitionSource): SandboxDefinitionBundle {
  if (typeof source === 'string') {
    return {
      entry: DEFAULT_DEFINITION_ENTRY,
      modules: {
        [DEFAULT_DEFINITION_ENTRY]: source,
      },
    }
  }

  return source
}

function createExecutionFiles(definitionName: string) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const baseDir = `/tmp/vitehub-sandbox/${definitionName.replace(/[^a-z0-9/_-]/gi, '_')}-${nonce}`
  return {
    baseDir,
    entryPath: `${baseDir}/entry.mjs`,
    inputPath: `${baseDir}/input.json`,
    outputPath: `${baseDir}/output.json`,
  }
}

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

function createEntrySource(definitionPath: string) {
  return [
    `import { readFile, writeFile } from 'node:fs/promises'`,
    `import { pathToFileURL } from 'node:url'`,
    ``,
    `function normalizeError(error) {`,
    `  if (error instanceof Error) {`,
    `    return {`,
    `      name: error.name,`,
    `      message: error.message,`,
    `      stack: error.stack,`,
    `      cause: error.cause ? String(error.cause) : undefined,`,
    `    }`,
    `  }`,
    `  return {`,
    `    name: 'Error',`,
    `    message: String(error),`,
    `  }`,
    `}`,
    ``,
    `export async function main(argv = process.argv.slice(2)) {`,
    `  const [inputPath, outputPath] = argv`,
    `  try {`,
    `    const mod = await import(pathToFileURL(${JSON.stringify(definitionPath)}).href)`,
    `    const definition = mod?.default`,
    `    if (!definition || typeof definition.run !== 'function')`,
    `      throw new Error('Sandbox definition must default-export defineSandbox(...).')`,
    `    const raw = await readFile(inputPath, 'utf8')`,
    `    const input = JSON.parse(raw || '{}')`,
    `    const result = await definition.run(input.payload, input.context)`,
    `    const output = JSON.stringify({ ok: true, result })`,
    `    await writeFile(outputPath, output)`,
    `    console.log('${EXEC_STDIO_OUTPUT_MARKER}' + output)`,
    `  }`,
    `  catch (error) {`,
    `    const output = JSON.stringify({ ok: false, error: normalizeError(error) })`,
    `    await writeFile(outputPath, output)`,
    `    console.error('${EXEC_STDIO_OUTPUT_MARKER}' + output)`,
    `    process.exitCode = 1`,
    `  }`,
    `}`,
    ``,
    `await main()`,
    ``,
  ].join('\n')
}

function resolveSandboxModulePath(baseDir: string, modulePath: string) {
  return `${baseDir}/${modulePath}`
}

async function writeSandboxDefinitionBundle(sandbox: SandboxClient, baseDir: string, bundle: SandboxDefinitionBundle) {
  await Promise.all(Object.entries(bundle.modules).map(async ([modulePath, source]) => {
    const filePath = resolveSandboxModulePath(baseDir, modulePath)
    await sandbox.mkdir(dirname(filePath), { recursive: true })
    await sandbox.writeFile(filePath, source)
  }))
}

function resolveLauncher(provider: SandboxClient['provider'], runtime?: SandboxDefinitionRuntime) {
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

function createHandlerError(message: string, provider: string, details?: Record<string, unknown>) {
  return new SandboxError(message, {
    code: 'SANDBOX_HANDLER_ERROR',
    provider,
    details,
  })
}

function createTimeoutError(provider: string, timeout: number) {
  return new SandboxError(`Sandbox definition timed out after ${timeout}ms.`, {
    code: 'TIMEOUT',
    provider,
    details: { timeout },
  })
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getErrorMessage(error: unknown) {
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

function resolveExecOutputRecoveryTimeout(timeout?: number) {
  if (!timeout || timeout <= 0)
    return DEFAULT_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS

  return Math.min(
    MAX_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS,
    Math.max(MIN_EXEC_OUTPUT_RECOVERY_TIMEOUT_MS, Math.floor(timeout * 0.1)),
  )
}

function tryParseSandboxOutput<TResult>(outputRaw: string) {
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

function extractSandboxOutputFromExecution(execution?: { stdout?: string, stderr?: string }) {
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

function getExecutionDiagnostics(execution?: { stdout?: string, stderr?: string, code?: number | null, meta?: Record<string, unknown> }) {
  return {
    args: Array.isArray(execution?.meta?.args) ? execution?.meta?.args : undefined,
    command: typeof execution?.meta?.command === 'string' ? execution.meta.command : undefined,
    cwd: typeof execution?.meta?.cwd === 'string' ? execution.meta.cwd : undefined,
    exitCode: typeof execution?.code === 'undefined' ? undefined : execution.code,
    stderrPreview: previewExecutionStream(execution?.stderr),
    stdoutPreview: previewExecutionStream(execution?.stdout),
  }
}

function getErrorDiagnostics(error: unknown) {
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

function isRecoverableCloudflareExecError(error: unknown) {
  const sandboxError = error instanceof SandboxError ? error : undefined
  const messages = [
    error instanceof Error ? error.message : String(error),
    error instanceof Error && error.cause instanceof Error ? error.cause.message : '',
    sandboxError?.cause instanceof Error ? sandboxError.cause.message : '',
  ].filter(Boolean).join('\n')

  if (sandboxError?.provider && sandboxError.provider !== 'cloudflare')
    return false

  if (sandboxError?.code === 'TIMEOUT' || sandboxError?.code === 'SANDBOX_TRANSPORT_ERROR')
    return true

  return CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE.test(messages)
}

function createExecOutputFailure(
  sandbox: SandboxClient,
  outputPath: string,
  error: unknown,
  recoveryTimeout: number,
  execution?: { stdout?: string, stderr?: string, code?: number | null, meta?: Record<string, unknown> },
  details?: Record<string, unknown>,
) {
  return createHandlerError('Sandbox definition execution failed before producing an output file.', sandbox.provider, {
    outputPath,
    cause: getErrorMessage(error),
    recoveryTimeout,
    ...details,
    ...getErrorDiagnostics(error),
    ...getExecutionDiagnostics(execution),
  })
}

async function waitForExecOutput(
  sandbox: SandboxClient,
  outputPath: string,
  error: unknown,
  timeout: number | undefined,
  execution: { stdout?: string, stderr?: string, code?: number | null, meta?: Record<string, unknown> } | undefined,
  shouldAccept: (output: string) => boolean,
) {
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
  execution?: { stdout?: string, stderr?: string, code?: number | null },
) {
  if (sandbox.provider !== 'cloudflare' || !isRecoverableCloudflareExecError(error))
    return null

  return await waitForExecOutput(sandbox, outputPath, error, timeout, execution, () => true)
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

  return await waitForExecOutput(
    sandbox,
    outputPath,
    error,
    timeout,
    execution,
    output => !!tryParseSandboxOutput(output),
  )
}

async function readExecOutputWithRecovery(
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

async function executeSandboxDefinitionOnce<TPayload, TResult>(
  sandbox: SandboxClient,
  definitionName: string,
  definitionOptions: SandboxDefinitionOptions | undefined,
  source: SandboxDefinitionSource,
  payload?: TPayload,
  context?: Record<string, unknown>,
) {
  const bundle = normalizeSandboxDefinitionBundle(source)

  const files = createExecutionFiles(definitionName)
  const definitionPath = resolveSandboxModulePath(files.baseDir, bundle.entry)
  const inputJson = toJson({ payload, context }, 'payload/context')

  await sandbox.mkdir(files.baseDir, { recursive: true })
  await writeSandboxDefinitionBundle(sandbox, files.baseDir, bundle)
  await Promise.all([
    sandbox.writeFile(files.entryPath, createEntrySource(definitionPath)),
    sandbox.writeFile(files.inputPath, inputJson),
  ])

  const launcher = resolveLauncher(sandbox.provider, definitionOptions?.runtime)
  const execArgs = [...launcher.args, files.entryPath, files.inputPath, files.outputPath]

  let outputRaw = ''
  let execution: Awaited<ReturnType<SandboxClient['exec']>> | undefined

  try {
    execution = await sandbox.exec(launcher.command, execArgs, {
      env: definitionOptions?.env,
      timeout: definitionOptions?.timeout,
    })
    outputRaw = await readExecOutputWithRecovery(sandbox, files.outputPath, execution, definitionOptions?.timeout, execution)
  }
  catch (error) {
    if (execution) {
      outputRaw = await readExecOutputWithRecovery(sandbox, files.outputPath, execution, definitionOptions?.timeout, execution)
    }
    else {
      outputRaw = await recoverExecOutput(sandbox, files.outputPath, error, definitionOptions?.timeout, execution) || ''
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

export async function executeSandboxDefinition<TPayload, TResult>(
  sandbox: SandboxClient,
  definitionName: string,
  definitionOptions: SandboxDefinitionOptions | undefined,
  source: SandboxDefinitionSource,
  payload?: TPayload,
  context?: Record<string, unknown>,
): Promise<TResult> {
  const timeout = definitionOptions?.timeout
  if (typeof timeout !== 'number' || timeout <= 0 || sandbox.provider === 'cloudflare') {
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

  try {
    return await Promise.race([
      executeSandboxDefinitionOnce(
        sandbox,
        definitionName,
        definitionOptions,
        source,
        payload,
        context,
      ),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(createTimeoutError(sandbox.provider, timeout)), timeout)
      }),
    ]) as TResult
  }
  finally {
    if (timeoutId)
      clearTimeout(timeoutId)
  }
}
