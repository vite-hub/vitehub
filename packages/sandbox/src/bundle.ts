import { bundleDiscoveredDefinitionModuleGraph } from './internal/shared/discovered-definition'
import type { SandboxDefinitionBundle } from './module-types'

const SHIM_NAMESPACE = 'vitehub-sandbox-runtime-shim'

export async function bundleSandboxDefinition(source: string, file: string): Promise<SandboxDefinitionBundle> {
  return await bundleDiscoveredDefinitionModuleGraph({
    filename: file,
    source,
    plugins: [
      {
        name: SHIM_NAMESPACE,
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^@vitehub\/sandbox(?:\/runtime\/public)?$/ }, () => ({
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
              'export function defineSandbox(run, options) {',
              '  return { run, options }',
              '}',
            ].join('\n'),
            loader: 'js',
          }))
        },
      },
    ],
  })
}
