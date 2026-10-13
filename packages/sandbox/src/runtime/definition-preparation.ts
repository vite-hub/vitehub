import { sandboxError } from '../sandbox/errors'
import { resolveSandboxModulePath, writeSandboxDefinitionBundle } from './execution-files'
import type { SandboxDefinitionBundle } from '../module-types'
import type { SandboxExecutionBox } from './execution-box'

const projectPreparations = new Map<string, Promise<void>>()

export async function prepareSandboxDefinition(
  sandbox: SandboxExecutionBox,
  bundle: SandboxDefinitionBundle,
  baseDir: string,
  options: { signal?: AbortSignal, timeout?: number },
) {
  const project = bundle.project
  if (!project) {
    await writeSandboxDefinitionBundle(sandbox, baseDir, bundle, options.signal)
    return { directory: baseDir, cwd: baseDir }
  }

  const projectDir = `/tmp/vitehub-sandbox/projects/${project.digest}`
  const marker = `${projectDir}/.vitehub/prepared`
  const prepared = { directory: projectDir, cwd: resolveSandboxModulePath(projectDir, project.packagePath) }
  await sandbox.mkdir('/tmp/vitehub-sandbox/projects', { recursive: true, signal: options.signal })
  if (await sandbox.exists(marker, { signal: options.signal }))
    return prepared

  const preparationKey = `${sandbox.id}:${project.digest}`
  while (!await sandbox.exists(marker, { signal: options.signal })) {
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
  return prepared
}

async function prepareSandboxProjectAtomically(
  sandbox: SandboxExecutionBox,
  bundle: SandboxDefinitionBundle & { project: NonNullable<SandboxDefinitionBundle['project']> },
  projectDir: string,
  marker: string,
  options: { signal?: AbortSignal, timeout?: number },
) {
  if (await sandbox.exists(marker, { signal: options.signal })) return
  const staging = `${projectDir}.staging-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  try {
    await sandbox.mkdir(staging, { recursive: true, signal: options.signal })
    await writeSandboxDefinitionBundle(sandbox, staging, bundle, options.signal)
    const result = await sandbox.exec(
      bundle.project.install.command,
      bundle.project.install.args,
      {
        signal: options.signal,
        timeout: options.timeout,
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
    await sandbox.mkdir(`${staging}/.vitehub`, { recursive: true, signal: options.signal })
    await sandbox.writeFile(`${staging}/.vitehub/prepared`, bundle.project.digest, { signal: options.signal })
    const published = await sandbox.exec('node', [
      '-e',
      'import("node:fs/promises").then(({ rename }) => rename(process.argv[1], process.argv[2]))',
      staging,
      projectDir,
    ], { signal: options.signal })
    if (!published.ok && !await sandbox.exists(marker, { signal: options.signal })) {
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
