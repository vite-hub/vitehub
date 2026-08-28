import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import { basename, dirname, join, normalize } from 'pathe'
import { prepareExecutablePackageProject } from './internal/package-entry'
import { findFilesystemPathReferences } from './internal/shared/discovered-definition/ast'
import { bundleDiscoveredDefinitionModuleGraph } from './internal/shared/discovered-definition'
import type { SandboxDefinitionBundle } from './module-types'
import type { SandboxProject } from './project'

const SHIM_NAMESPACE = 'vitehub-sandbox-runtime-shim'
const builtinModuleSet = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
])

function isRelativeFilesystemPath(path: string) {
  return !!path
    && !/^[/\\]/.test(path)
    && !/^[A-Za-z]:[/\\]/.test(path)
    && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(path)
}

function findDefinitionProjectPath(file: string, project: SandboxProject) {
  const normalizedFile = normalize(file.replaceAll('\\', '/'))
  return Object.keys(project.files)
    .filter(path => normalizedFile.endsWith(`/${normalize(path)}`))
    .sort((left, right) => right.length - left.length)[0]
}

function containsProjectPath(projectPaths: Set<string>, path: string) {
  if (path.startsWith('../'))
    return false
  if (!path || path === '.')
    return projectPaths.size > 0
  return projectPaths.has(path) || [...projectPaths].some(projectPath => projectPath.startsWith(`${path}/`))
}

function hasProjectAssetReference(
  modules: Record<string, string>,
  file: string,
  project: SandboxProject,
  source: string,
) {
  const projectPaths = new Set(Object.keys(project.files).map(path => normalize(path)))
  const packagePath = project.packagePath === '.' ? '' : normalize(project.packagePath)
  const definitionPath = findDefinitionProjectPath(file, project)
  return [[file, source], ...Object.entries(modules)].some(([modulePath, contents]) => {
    return findFilesystemPathReferences(contents, modulePath).some((reference) => {
      // A recognized filesystem operation with a computed target may still
      // read a project asset, so preserve the project unless proven otherwise.
      if (reference.path === undefined)
        return true
      if (!isRelativeFilesystemPath(reference.path))
        return false
      const relativePath = normalize(reference.path.replaceAll('\\', '/'))
      if (reference.relativeTo === 'working-directory') {
        const projectPath = normalize(join(packagePath, relativePath))
        return containsProjectPath(projectPaths, projectPath)
      }
      if (definitionPath) {
        const projectPath = normalize(join(dirname(definitionPath), relativePath))
        if (containsProjectPath(projectPaths, projectPath))
          return true
      }
      const suffix = relativePath.replace(/^(?:\.\.\/)+/, '').replace(/^\.\//, '')
      return !!suffix && [...projectPaths].some(path => path === suffix
        || path.endsWith(`/${suffix}`)
        || path.startsWith(`${suffix}/`)
        || path.includes(`/${suffix}/`))
    })
  })
}

export async function bundleSandboxDefinition(
  source: string,
  file: string,
  options: {
    alias?: Record<string, string>
    execution?: SandboxDefinitionBundle['execution']
    includeProject?: boolean
    project?: SandboxProject
  } = {},
): Promise<SandboxDefinitionBundle> {
  if (options.includeProject === true && !options.project)
    throw new Error(`[vitehub] Sandbox Definition ${file} declares project: true but no project was resolved.`)
  const project = options.includeProject === false ? undefined : options.project
  if (options.execution === 'module' && project) {
    const prefix = project.packagePath === '.' ? '' : `${project.packagePath}/`
    const entry = `${prefix}${basename(file)}`
    const executable = prepareExecutablePackageProject(project, entry)
    return {
      entry: executable.entry,
      execution: 'module',
      modules: {},
      project: executable.project,
    }
  }

  const {
    externalImports,
    hasRuntimeModuleResolution,
    ...bundle
  } = await bundleDiscoveredDefinitionModuleGraph({
    alias: options.alias,
    filename: file,
    packages: project ? 'external' : 'bundle',
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
              '  const { project: _project, run, ...options } = input',
              '  return { run, options: Object.keys(options).length ? options : undefined }',
              '}',
            ].join('\n'),
            loader: 'js',
          }))
        },
      },
    ],
  })
  const hasUnbundledRuntimeDependency = hasRuntimeModuleResolution
    || externalImports.some(specifier => !builtinModuleSet.has(specifier))
  if (options.includeProject === false && hasUnbundledRuntimeDependency) {
    throw new Error(
      `[vitehub] Sandbox Definition ${file} declares project: false but has a runtime dependency that could not be bundled.`,
    )
  }
  const requiresProject = options.includeProject === true
    || (options.includeProject !== false && (
      hasUnbundledRuntimeDependency
      || (!!project && hasProjectAssetReference(bundle.modules, file, project, source))
    ))
  if (!project || !requiresProject) {
    return {
      ...bundle,
      ...(options.execution ? { execution: options.execution } : {}),
    }
  }

  const prefix = project.packagePath === '.'
    ? '.vitehub-sandbox'
    : `${project.packagePath}/.vitehub-sandbox`
  const modules = {
    [`${prefix}/package.json`]: JSON.stringify({ private: true, type: 'module' }),
    ...Object.fromEntries(
      Object.entries(bundle.modules).map(([path, contents]) => [`${prefix}/${path}`, contents]),
    ),
  }
  const digest = createHash('sha256')
    .update(JSON.stringify({ modules, packagePath: project.packagePath, project: project.digest }))
    .digest('hex')
  return {
    entry: `${prefix}/${bundle.entry}`,
    ...(options.execution ? { execution: options.execution } : {}),
    modules,
    project: { ...project, digest },
  }
}
