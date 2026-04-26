import { SandboxError } from '../sandbox/errors'
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

import type { SandboxClient } from '../sandbox/types'
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
