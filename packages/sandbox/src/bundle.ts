import { createHash } from 'node:crypto'
import { bundleDiscoveredDefinitionModuleGraph } from './internal/shared/discovered-definition'
import type { SandboxDefinitionBundle } from './module-types'
import type { SandboxProject } from './project'

const SHIM_NAMESPACE = 'vitehub-sandbox-runtime-shim'

export async function bundleSandboxDefinition(
  source: string,
  file: string,
  options: {
    alias?: Record<string, string>
    execution?: SandboxDefinitionBundle['execution']
    project?: SandboxProject
  } = {},
): Promise<SandboxDefinitionBundle> {
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
