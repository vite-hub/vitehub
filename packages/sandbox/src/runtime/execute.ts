import { decodeSandboxValue, encodeSandboxValue } from './binary-sidecars'
import { sandboxError } from '../sandbox/errors'
import { readSandboxErrorMetadata } from './error-normalization'
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
import type { SandboxExecutionBox } from './execution-box'

import type { SandboxDefinitionBundle, SandboxDefinitionOptions } from '../module-types'

const defaultNodeLauncher = 'import(process.argv[1])'
const projectPreparations = new Map<string, Promise<void>>()

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

function resolveLauncher() {
  return {
    command: 'node',
    args: ['-e', defaultNodeLauncher],
  }
}

async function prepareSandboxProject(
  sandbox: SandboxExecutionBox,
  bundle: SandboxDefinitionBundle,
  baseDir: string,
  options: { deadline?: number, signal?: AbortSignal, timeout?: number },
) {
  const project = bundle.project
  if (!project)
    return baseDir

  const projectDir = `/tmp/vitehub-sandbox/projects/${project.digest}`
  const marker = `${projectDir}/.vitehub/prepared`
  await sandbox.mkdir('/tmp/vitehub-sandbox/projects', { recursive: true })
  if (await sandbox.exists(marker))
    return projectDir

  const preparationKey = `${sandbox.id}:${project.digest}`
  while (!await sandbox.exists(marker)) {
    let preparation = projectPreparations.get(preparationKey)
    let owned = false
    if (!preparation) {
      owned = true
      preparation = prepareSandboxProjectAtomically(sandbox, { ...bundle, project }, projectDir, marker, options)
      projectPreparations.set(preparationKey, preparation)
      void preparation.finally(() => {
        if (projectPreparations.get(preparationKey) === preparation)
          projectPreparations.delete(preparationKey)
      }).catch(() => {})
    }
    try {
      await preparation
    }
    catch (error) {
      if (projectPreparations.get(preparationKey) === preparation)
        projectPreparations.delete(preparationKey)
      if (owned || options.signal?.aborted) throw error
      continue
    }
    if (projectPreparations.get(preparationKey) === preparation)
      projectPreparations.delete(preparationKey)
  }
  return projectDir
}

async function prepareSandboxProjectAtomically(
  sandbox: SandboxExecutionBox,
  bundle: SandboxDefinitionBundle & { project: NonNullable<SandboxDefinitionBundle['project']> },
  projectDir: string,
  marker: string,
  options: { deadline?: number, signal?: AbortSignal, timeout?: number },
) {
  if (await sandbox.exists(marker)) return
  const staging = `${projectDir}.staging-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  try {
    await sandbox.mkdir(staging, { recursive: true })
    await writeSandboxDefinitionBundle(sandbox, staging, bundle)
    const result = await executeLauncher(
      sandbox,
      bundle.project.install.command,
      bundle.project.install.args,
      {
        ...options,
        cwd: resolveSandboxModulePath(staging, bundle.project.install.cwd),
      },
    )
    if (!result.ok) {
      throw sandboxError('Sandbox package preparation failed.', {
        code: 'SANDBOX_EXECUTION_ERROR',
        details: {
          command: bundle.project.install.command,
          exitCode: result.code,
          stderr: result.stderr,
        },
      })
    }
    await sandbox.mkdir(`${staging}/.vitehub`, { recursive: true })
    await sandbox.writeFile(`${staging}/.vitehub/prepared`, bundle.project.digest)
    const published = await sandbox.exec('node', [
      '-e',
      'import("node:fs/promises").then(({ rename }) => rename(process.argv[1], process.argv[2]))',
      staging,
      projectDir,
    ], { signal: options.signal })
    if (!published.ok && !await sandbox.exists(marker)) {
      throw sandboxError('Sandbox package preparation could not publish its project.', {
        code: 'SANDBOX_EXECUTION_ERROR',
        details: { exitCode: published.code, stderr: published.stderr },
      })
    }
  }
  finally {
    await sandbox.exec('rm', ['-rf', '--', staging]).catch(() => {})
  }
}

async function executeLauncher(
  sandbox: SandboxExecutionBox,
  command: string,
  args: string[],
  options: { cwd?: string, deadline?: number, env?: Record<string, string>, signal?: AbortSignal, timeout?: number },
) {
  return await sandbox.exec(command, args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    timeout: options.timeout,
  })
}

async function executeSandboxDefinitionOnce<TPayload, TResult>(
  sandbox: SandboxExecutionBox,
  definitionName: string,
  definitionOptions: SandboxDefinitionOptions | undefined,
  source: SandboxDefinitionSource,
  payload?: TPayload,
  context?: Record<string, unknown>,
  signal?: AbortSignal,
  deadline?: number,
  onExecutionStart?: () => void,
) {
  const bundle = normalizeSandboxDefinitionBundle(source)

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
        ), 'payload/context')
      : undefined
    const bundleBaseDir = await prepareSandboxProject(sandbox, bundle, files.baseDir, {
      deadline,
      signal,
      timeout: definitionOptions?.timeout,
    })
    if (!bundle.project)
      await writeSandboxDefinitionBundle(sandbox, bundleBaseDir, bundle)
    inputJson ||= toJson(await encodeSandboxValue(
      sandbox,
      { payload, context },
      files.inputAssetsDir,
      'payload/context',
      signal,
    ), 'payload/context')
    const definitionPath = resolveSandboxModulePath(bundleBaseDir, bundle.entry)
    throwIfAborted()
    await Promise.all([
      sandbox.writeFile(files.entryPath, createEntrySource(definitionPath, bundle.execution)),
      sandbox.writeFile(files.inputPath, inputJson),
    ])
    throwIfAborted()

    const launcher = resolveLauncher()
    const execArgs = [...launcher.args, files.entryPath, files.inputPath, files.outputPath]

    let outputRaw = ''
    let execution: Awaited<ReturnType<SandboxExecutionBox['exec']>> | undefined

    try {
      onExecutionStart?.()
      execution = await executeLauncher(sandbox, launcher.command, execArgs, {
        cwd: bundle.project
          ? resolveSandboxModulePath(bundleBaseDir, bundle.project.packagePath)
          : files.baseDir,
        deadline,
        env: definitionOptions?.env,
        signal,
        timeout: definitionOptions?.timeout,
      })
      outputRaw = await readExecOutputWithRecovery(sandbox, files.outputPath, execution, definitionOptions?.timeout, execution)
    }
    catch (error) {
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

    const output = tryParseSandboxOutput<TResult>(outputRaw)
      || tryParseSandboxOutput(extractSandboxOutputFromExecution(execution) || '')

    if (!output) {
      throw createHandlerError('Sandbox definition output is not valid JSON.', sandbox.provider, {
        output: outputRaw,
        cause: 'Output file was empty or contained incomplete JSON.',
      })
    }

    if (output.ok)
      return await decodeSandboxValue(sandbox, output.result, files.outputAssetsDir, 'result') as TResult

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

export async function executeSandboxDefinition<TPayload, TResult>(
  sandbox: SandboxExecutionBox,
  definitionName: string,
  definitionOptions: SandboxDefinitionOptions | undefined,
  source: SandboxDefinitionSource,
  payload?: TPayload,
  context?: Record<string, unknown>,
  onExecutionStart?: () => void,
): Promise<TResult> {
  const timeout = definitionOptions?.timeout
  if (typeof timeout !== 'number' || timeout <= 0) {
    return await executeSandboxDefinitionOnce(
      sandbox,
      definitionName,
      definitionOptions,
      source,
      payload,
      context,
      undefined,
      undefined,
      onExecutionStart,
    )
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const abortController = new AbortController()
  const deadline = Date.now() + timeout

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
        deadline,
        onExecutionStart,
      ),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          const timeoutError = createTimeoutError(sandbox.provider, timeout)
          abortController.abort(timeoutError)
          reject(timeoutError)
        }, timeout)
      }),
    ]) as TResult
  }
  finally {
    if (timeoutId)
      clearTimeout(timeoutId)
  }
}
