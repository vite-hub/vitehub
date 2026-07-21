import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, normalize } from 'node:path/posix'
import {
  findCommonJSImportEqualsSpecifiers,
  findExecutableCommonJSModuleSpecifiers,
  findRuntimeModuleSpecifiers,
  hasNonLiteralDynamicImport,
  rewriteRuntimeRelativeModuleSpecifiers,
} from './shared/discovered-definition/ast'
import { isWorkspacePackage, parsePnpmWorkspacePackages } from '../project'
import type { SandboxProject } from '../project'
import type ts from 'typescript'

const require = createRequire(import.meta.url)
const typescript = require('typescript') as typeof import('typescript')
const runtimeExportConditions = new Set(['default', 'import', 'module-sync', 'node', 'node-addons'])

type PackageRuntimeManifest = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  exports?: unknown
  main?: unknown
  name?: unknown
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  type?: unknown
}

function isExecutableTypeScriptModule(path: string) {
  return /\.(?:ts|mts)$/.test(path) && !/\.d\.(?:ts|mts)$/.test(path)
}

function executablePackageModulePath(path: string) {
  const suffixIndex = path.search(/[?#]/)
  const modulePath = suffixIndex === -1 ? path : path.slice(0, suffixIndex)
  const suffix = suffixIndex === -1 ? '' : path.slice(suffixIndex)
  return isExecutableTypeScriptModule(modulePath) ? `${modulePath}.mjs${suffix}` : path
}

function projectFileSource(project: SandboxProject, path: string) {
  const file = project.files[path]
  if (!file) throw new Error(`[vitehub] Sandbox package project is missing required file: ${path}`)
  return Buffer.from(file.contents, file.encoding).toString()
}

function parseRuntimeManifest(project: SandboxProject, path: string) {
  try {
    return JSON.parse(projectFileSource(project, path)) as PackageRuntimeManifest
  } catch (error) {
    throw new Error(`[vitehub] Sandbox package manifest is invalid JSON: ${path}`, {
      cause: error,
    })
  }
}

function selectedPackageManifest(project: SandboxProject) {
  const path = project.packagePath === '.' ? 'package.json' : `${project.packagePath}/package.json`
  const manifest = parseRuntimeManifest(project, path)
  if (manifest.type !== 'module') {
    throw new Error(
      `[vitehub] Sandbox package manifest "${path}" must set "type" to "module". Canonical Sandbox package entrypoints are ESM.`,
    )
  }
  return manifest
}

function declaredWorkspaceDependencyNames(manifest: PackageRuntimeManifest) {
  return [
    ...new Set(
      [
        manifest.dependencies,
        manifest.devDependencies,
        manifest.optionalDependencies,
        manifest.peerDependencies,
      ]
        .flatMap((section) => Object.entries(section || {}))
        .filter(([, specifier]) => specifier.startsWith('workspace:'))
        .map(([name]) => name),
    ),
  ]
}

function runtimeExportTargets(value: unknown, patternMatch?: string): string[] {
  if (typeof value === 'string') {
    const target = patternMatch === undefined ? value : value.replaceAll('*', patternMatch)
    return target.startsWith('./') ? [target] : []
  }
  if (Array.isArray(value)) {
    for (const target of value) {
      const targets = runtimeExportTargets(target, patternMatch)
      if (targets.length) return targets
    }
    return []
  }
  if (!value || typeof value !== 'object') return []
  for (const [condition, target] of Object.entries(value)) {
    if (runtimeExportConditions.has(condition)) {
      const targets = runtimeExportTargets(target, patternMatch)
      if (targets.length) return targets
    }
  }
  return []
}

function runtimeTargetsForPackageSpecifier(
  manifest: PackageRuntimeManifest,
  packageName: string,
  specifier: string,
) {
  if (manifest.exports !== undefined) {
    let selected: unknown = manifest.exports
    let patternMatch: string | undefined
    if (selected && typeof selected === 'object' && !Array.isArray(selected)) {
      const entries = selected as Record<string, unknown>
      const hasSubpaths = Object.keys(entries).some((key) => key.startsWith('.'))
      if (hasSubpaths) {
        const subpath = specifier === packageName ? '.' : `.${specifier.slice(packageName.length)}`
        if (Object.hasOwn(entries, subpath)) {
          selected = entries[subpath]
        } else {
          const pattern = Object.keys(entries)
            .filter((key) => {
              const star = key.indexOf('*')
              if (star === -1) return false
              return subpath.startsWith(key.slice(0, star))
                && subpath.endsWith(key.slice(star + 1))
            })
            .sort((left, right) => {
              const leftStar = left.indexOf('*')
              const rightStar = right.indexOf('*')
              return rightStar - leftStar || right.length - left.length
            })[0]
          if (pattern) {
            const star = pattern.indexOf('*')
            patternMatch = subpath.slice(star, subpath.length - (pattern.length - star - 1))
            selected = entries[pattern]
          } else {
            selected = undefined
          }
        }
      } else if (specifier !== packageName) {
        selected = undefined
      }
    } else if (specifier !== packageName) {
      selected = undefined
    }
    return runtimeExportTargets(selected, patternMatch)
  }
  if (specifier !== packageName) return [`.${specifier.slice(packageName.length)}`]
  return typeof manifest.main === 'string' ? [manifest.main] : ['./index.js']
}

function isTypeScriptRuntimeTarget(path: string) {
  const target = path.replace(/[?#].*$/, '')
  return /\.[cm]?tsx?$/.test(target) && !/\.d\.[cm]?ts$/.test(target)
}

function validateWorkspaceJavaScriptGraph(
  project: SandboxProject,
  packageName: string,
  manifestPath: string,
  targets: string[],
) {
  const pending = targets
    .filter((target) => /\.(?:js|mjs)$/.test(target.replace(/[?#].*$/, '')))
    .map((target) => normalize(join(dirname(manifestPath), target.replace(/[?#].*$/, ''))))
  const visited = new Set<string>()
  const runtimePackages = new Set<string>()
  while (pending.length) {
    const path = pending.shift()!
    if (visited.has(path) || !Object.hasOwn(project.files, path)) continue
    visited.add(path)
    const source = projectFileSource(project, path)
    for (const specifier of findRuntimeModuleSpecifiers(source, path)) {
      if (!/^\.\.?\//.test(specifier)) {
        if (!specifier.startsWith('node:')) runtimePackages.add(specifier)
        continue
      }
      const target = normalize(join(dirname(path), specifier.replace(/[?#].*$/, '')))
      if (isTypeScriptRuntimeTarget(target)) {
        throw new Error(
          `[vitehub] Sandbox workspace dependency "${packageName}" exposes TypeScript runtime target "${specifier}" from "${path}". Build dependencies to JavaScript before Sandbox execution.`,
        )
      }
      if (/\.(?:js|mjs)$/.test(target)) pending.push(target)
    }
  }
  return runtimePackages
}

function validateWorkspaceRuntimeExports(
  project: SandboxProject,
  runtimePackages: Iterable<string>,
  declaredWorkspacePackages: Iterable<string>,
) {
  const pending = [...runtimePackages]
  if (!pending.length) return
  const workspacePackages = new Set(declaredWorkspacePackages)
  if (!workspacePackages.size) return
  const workspaceFile = project.files['pnpm-workspace.yaml']
  if (!workspaceFile) return
  const workspacePatterns = parsePnpmWorkspacePackages(
    Buffer.from(workspaceFile.contents, workspaceFile.encoding).toString(),
  )
  const manifests = new Map<string, { manifest: PackageRuntimeManifest; path: string }>()
  for (const path of Object.keys(project.files).filter(
    (path) => path === 'package.json'
      || (path.endsWith('/package.json')
        && isWorkspacePackage(dirname(path), workspacePatterns)),
  )) {
    let manifest: PackageRuntimeManifest
    try {
      const value: unknown = JSON.parse(projectFileSource(project, path))
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      manifest = value as PackageRuntimeManifest
    } catch {
      continue
    }
    if (typeof manifest.name === 'string') manifests.set(manifest.name, { manifest, path })
  }

  const visited = new Set<string>()
  while (pending.length) {
    const specifier = pending.shift()!
    if (visited.has(specifier)) continue
    visited.add(specifier)
    const packageName = barePackageName(specifier)
    if (!workspacePackages.has(packageName)) continue
    const dependency = manifests.get(packageName)
    if (!dependency) continue
    const targets = runtimeTargetsForPackageSpecifier(
      dependency.manifest,
      packageName,
      specifier,
    )
    const target = targets.find(isTypeScriptRuntimeTarget)
    if (target) {
      throw new Error(
        `[vitehub] Sandbox workspace dependency "${packageName}" exposes TypeScript runtime target "${target}" in "${dependency.path}". Build dependencies to JavaScript before Sandbox execution.`,
      )
    }
    const runtimePackageEdges = validateWorkspaceJavaScriptGraph(
      project,
      packageName,
      dependency.path,
      targets,
    )
    for (const name of declaredWorkspaceDependencyNames(dependency.manifest)) {
      workspacePackages.add(name)
    }
    pending.push(...runtimePackageEdges)
  }
}

function isInsideSelectedPackage(project: SandboxProject, path: string) {
  if (project.packagePath === '.') return path !== '..' && !path.startsWith('../')
  return path.startsWith(`${project.packagePath}/`)
}

function removeTypeOnlyModuleDeclarations(context: ts.TransformationContext) {
  return (sourceFile: ts.SourceFile) =>
    context.factory.updateSourceFile(
      sourceFile,
      sourceFile.statements.filter((statement) => {
        if (typescript.isImportDeclaration(statement)) {
          const clause = statement.importClause
          const bindings = clause?.namedBindings
          return !(
            clause &&
            !clause.name &&
            bindings &&
            typescript.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((element) => element.isTypeOnly)
          )
        }
        if (typescript.isExportDeclaration(statement)) {
          const clause = statement.exportClause
          return !(
            clause &&
            typescript.isNamedExports(clause) &&
            clause.elements.length > 0 &&
            clause.elements.every((element) => element.isTypeOnly)
          )
        }
        return true
      }),
    )
}

function transpilePackageModule(source: string, path: string) {
  const result = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ESNext,
      target: typescript.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
    fileName: path,
    reportDiagnostics: true,
    transformers: { before: [removeTypeOnlyModuleDeclarations] },
  })
  const errors =
    result.diagnostics?.filter(
      (diagnostic) => diagnostic.category === typescript.DiagnosticCategory.Error,
    ) || []
  if (errors.length) {
    const details = errors
      .map((diagnostic) => typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      .join('\n')
    throw new Error(
      `[vitehub] Sandbox package module "${path}" could not be transpiled:\n${details}`,
    )
  }
  return result.outputText
}

function barePackageName(specifier: string) {
  const [scopeOrName, name] = specifier.split('/')
  return scopeOrName.startsWith('@') && name ? `${scopeOrName}/${name}` : scopeOrName
}

function isUnsupportedExternalModuleSpecifier(specifier: string) {
  return (
    specifier.startsWith('/') ||
    specifier.startsWith('\\') ||
    (/^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier) && !specifier.startsWith('node:'))
  )
}

function throwCommonJSSyntax(
  path: string,
  commonJS: ReturnType<typeof findExecutableCommonJSModuleSpecifiers>[number],
): never {
  const syntax = {
    'exports-assignment': 'exports assignment',
    'exports-reference': 'exports reference',
    'import-equals': 'import = require()',
    'module-exports-assignment': 'module.exports assignment',
    'module-reference': 'module reference',
    require: 'require()',
    'require-property': commonJS.specifier
      ? `require.${commonJS.specifier}`
      : 'require property access',
  }[commonJS.syntax]
  const target =
    commonJS.specifier && commonJS.syntax !== 'require-property'
      ? ` for "${commonJS.specifier}"`
      : ''
  throw new Error(
    `[vitehub] Sandbox package module "${path}" uses CommonJS ${syntax}${target}. Canonical Sandbox package entrypoints are ESM; use import or export syntax.`,
  )
}

function validatePackageModuleSpecifiers(
  project: SandboxProject,
  entry: string,
  packageName?: string,
) {
  const pending = [entry]
  const runtimePackages = new Set<string>()
  const visited = new Set<string>()
  while (pending.length) {
    const path = pending.shift()!
    if (visited.has(path)) continue
    visited.add(path)
    const source = projectFileSource(project, path)
    if (hasNonLiteralDynamicImport(source, path)) {
      throw new Error(
        `[vitehub] Sandbox package module "${path}" uses a non-literal dynamic import. Canonical Sandbox package entrypoints require literal import() specifiers.`,
      )
    }
    const importEquals = findCommonJSImportEqualsSpecifiers(source, path)[0]
    if (importEquals)
      throwCommonJSSyntax(path, importEquals)
    const moduleSpecifiers = findRuntimeModuleSpecifiers(source, path)
    for (const specifier of moduleSpecifiers) {
      if (specifier.startsWith('#')) {
        throw new Error(
          `[vitehub] Sandbox package module "${path}" imports package alias "${specifier}". Use an explicit relative ESM import for local Sandbox source.`,
        )
      }
      if (packageName && (specifier === packageName || specifier.startsWith(`${packageName}/`))) {
        throw new Error(
          `[vitehub] Sandbox package module "${path}" self-imports "${specifier}". Use an explicit relative ESM import for local Sandbox source.`,
        )
      }
      if (isUnsupportedExternalModuleSpecifier(specifier)) {
        throw new Error(
          `[vitehub] Sandbox package module "${path}" imports absolute or URL module "${specifier}". Use a relative module inside the package or a runtime-ready package dependency.`,
        )
      }
      if (!/^\.\.?\//.test(specifier) && !specifier.startsWith('node:')) {
        runtimePackages.add(specifier)
      }
    }
    for (const specifier of moduleSpecifiers.filter((specifier) => /^\.\.?\//.test(specifier))) {
      const target = normalize(join(dirname(path), specifier.replace(/[?#].*$/, '')))
      if (!isInsideSelectedPackage(project, target)) {
        throw new Error(
          `[vitehub] Sandbox package module "${path}" imports "${specifier}" outside its package. Declare runtime-ready JavaScript as a package dependency instead.`,
        )
      }
      if (!Object.hasOwn(project.files, target)) {
        throw new Error(
          `[vitehub] Sandbox package module "${path}" imports "${specifier}", which is not an executable package file. Use an explicit extension that resolves to a package file.`,
        )
      }
      if (/\.(?:cjs|cts)$/.test(target)) {
        throw new Error(
          `[vitehub] Sandbox package module "${path}" imports CommonJS module "${specifier}". Canonical Sandbox package source must use ESM JavaScript or TypeScript modules.`,
        )
      }
      if (/\.[cm]?[jt]sx$/.test(target)) {
        throw new Error(
          `[vitehub] Sandbox package module "${path}" imports JSX module "${specifier}". Canonical Sandbox package source does not compile JSX.`,
        )
      }
      if (/\.d\.[cm]?ts$/.test(target)) {
        throw new Error(
          `[vitehub] Sandbox package module "${path}" imports declaration file "${specifier}" at runtime. Use an import type declaration instead.`,
        )
      }
      if (/\.(?:js|mjs|ts|mts)$/.test(target)) pending.push(target)
    }
  }
  return { modulePaths: visited, runtimePackages }
}

export function prepareExecutablePackageProject(project: SandboxProject, entry: string) {
  const manifest = selectedPackageManifest(project)
  const packageName = typeof manifest.name === 'string' ? manifest.name : undefined
  const { modulePaths, runtimePackages } = validatePackageModuleSpecifiers(
    project,
    entry,
    packageName,
  )
  validateWorkspaceRuntimeExports(
    project,
    runtimePackages,
    declaredWorkspaceDependencyNames(manifest),
  )
  const generatedFiles: SandboxProject['files'] = {}
  const executableSources = new Map<string, string>()
  const originalPaths = new Map<string, string>()
  const files = { ...project.files }

  for (const path of modulePaths) {
    const file = project.files[path]!
    const source = Buffer.from(file.contents, file.encoding).toString()
    const rewritten = rewriteRuntimeRelativeModuleSpecifiers(
      source,
      path,
      executablePackageModulePath,
    )
    if (isExecutableTypeScriptModule(path)) {
      const executablePath = executablePackageModulePath(path)
      if (Object.hasOwn(project.files, executablePath)) {
        throw new Error(
          `[vitehub] Sandbox package module "${path}" conflicts with generated executable "${executablePath}". Rename the existing file.`,
        )
      }
      const executableSource = transpilePackageModule(rewritten, path)
      executableSources.set(executablePath, executableSource)
      originalPaths.set(executablePath, path)
      generatedFiles[executablePath] = {
        contents: Buffer.from(executableSource).toString('base64'),
        encoding: 'base64',
      }
    } else {
      executableSources.set(path, rewritten)
      originalPaths.set(path, path)
      if (rewritten !== source) {
        generatedFiles[path] = {
          ...file,
          contents: Buffer.from(rewritten).toString('base64'),
        }
      }
    }
  }

  const commonJS = findExecutableCommonJSModuleSpecifiers(executableSources)[0]
  if (commonJS)
    throwCommonJSSyntax(originalPaths.get(commonJS.path) || commonJS.path, commonJS)

  if (!Object.keys(generatedFiles).length) return { entry, project }

  Object.assign(files, generatedFiles)
  const digest = createHash('sha256')
    .update(JSON.stringify({ generatedFiles, project: project.digest }))
    .digest('hex')
  return {
    entry: executablePackageModulePath(entry),
    project: { ...project, digest, files },
  }
}
