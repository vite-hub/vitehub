import { createHash } from 'node:crypto'
import { basename } from 'pathe'
import { dirname, join, normalize } from 'node:path/posix'
import { bundleDiscoveredDefinitionModuleGraph } from './internal/shared/discovered-definition'
import { findRuntimeRelativeModuleSpecifiers } from './internal/shared/discovered-definition/ast'
import type { SandboxDefinitionBundle } from './module-types'
import type { SandboxProject } from './project'

const SHIM_NAMESPACE = 'vitehub-sandbox-runtime-shim'

function validatePackageModuleSpecifiers(project: SandboxProject, entry: string) {
  const pending = [entry]
  const visited = new Set<string>()
  while (pending.length) {
    const path = pending.shift()!
    if (visited.has(path))
      continue
    visited.add(path)
    const file = project.files[path]
    if (!file)
      throw new Error(`[vitehub] Sandbox package entry is missing from project files: ${entry}`)
    const source = Buffer.from(file.contents, file.encoding).toString()
    for (const specifier of findRuntimeRelativeModuleSpecifiers(source, path)) {
      const target = normalize(join(dirname(path), specifier.replace(/[?#].*$/, '')))
      if (!Object.hasOwn(project.files, target)) {
        throw new Error(
          `[vitehub] Sandbox package module "${path}" imports "${specifier}", which is not an executable package file. Use an explicit extension that resolves to a package file.`,
        )
      }
      if (/\.(?:c|m)?[jt]sx?$/.test(target) && !/\.d\.(?:c|m)?tsx?$/.test(target))
        pending.push(target)
    }
  }
}

export async function bundleSandboxDefinition(
  source: string,
  file: string,
  options: {
    alias?: Record<string, string>
    execution?: SandboxDefinitionBundle['execution']
    project?: SandboxProject
  } = {},
): Promise<SandboxDefinitionBundle> {
  if (options.execution === 'module' && options.project) {
    const prefix = options.project.packagePath === '.' ? '' : `${options.project.packagePath}/`
    const entry = `${prefix}${basename(file)}`
    validatePackageModuleSpecifiers(options.project, entry)
    return {
      entry,
      execution: 'module',
      modules: {},
      project: options.project,
    }
  }

  const bundle = await bundleDiscoveredDefinitionModuleGraph({
    alias: options.alias,
    filename: file,
    packages: options.project ? 'external' : 'bundle',
    source,
    plugins: [
      {
        name: SHIM_NAMESPACE,
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^@vite-hub\/sandbox(?:\/runtime\/public)?$/ }, () => ({
            path: 'sandbox-runtime-shim',
            namespace: SHIM_NAMESPACE,
          }))

          pluginBuild.onLoad({ filter: /.*/, namespace: SHIM_NAMESPACE }, () => ({
            contents: [
              'function hasStandardValidator(value) {',
              '  return !!value && typeof value === "object" && !!value["~standard"] && typeof value["~standard"].validate === "function"',
              '}',
              '',
              'function createValidationError(cause) {',
              '  if (cause instanceof Error)',
              '    return cause',
              '  const message = cause && typeof cause === "object" && typeof cause.message === "string"',
              '    ? cause.message',
              '    : "Validation failed"',
              '  return Object.assign(new Error(message), cause && typeof cause === "object" ? cause : {})',
              '}',
              '',
              'export async function readValidatedPayload(payload, validate) {',
              '  if (hasStandardValidator(validate)) {',
              '    const result = await validate["~standard"].validate(payload)',
              '    if (result.issues?.length)',
              '      throw createValidationError({ message: "Validation failed", issues: result.issues })',
              '    return result.value',
              '  }',
              '  try {',
              '    const result = await validate(payload)',
              '    if (result === false)',
              '      throw createValidationError({ message: "Validation failed" })',
              '    return result === true || result == null ? payload : result',
              '  }',
              '  catch (error) {',
              '    throw createValidationError(error)',
              '  }',
              '}',
              '',
              'export function defineSandbox(input) {',
              '  const { run, ...options } = input',
              '  return { run, options: Object.keys(options).length ? options : undefined }',
              '}',
            ].join('\n'),
            loader: 'js',
          }))
        },
      },
    ],
  })
  if (!options.project) {
    return {
      ...bundle,
      ...(options.execution ? { execution: options.execution } : {}),
    }
  }

  const prefix = options.project.packagePath === '.'
    ? '.vitehub-sandbox'
    : `${options.project.packagePath}/.vitehub-sandbox`
  const modules = {
    [`${prefix}/package.json`]: JSON.stringify({ private: true, type: 'module' }),
    ...Object.fromEntries(
      Object.entries(bundle.modules).map(([path, contents]) => [`${prefix}/${path}`, contents]),
    ),
  }
  const digest = createHash('sha256')
    .update(JSON.stringify({ modules, packagePath: options.project.packagePath, project: options.project.digest }))
    .digest('hex')
  return {
    entry: `${prefix}/${bundle.entry}`,
    ...(options.execution ? { execution: options.execution } : {}),
    modules,
    project: { ...options.project, digest },
  }
}
