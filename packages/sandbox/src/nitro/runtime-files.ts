import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createImportPath, generatedDirSegments } from '@vitehub/internal/build/paths'
import { createRuntimeRegistryContents, sanitizeDefinitionFilename, writeFileIfChanged } from '@vitehub/internal/definition-discovery'

import { bundleSandboxDefinition } from '../bundle'
import { extractSandboxDefinitionOptions } from '../definition-options'
import { discoverNitroSandboxDefinitions } from '../discovery'
import { createDiscoveredDefinitionCompiler } from '../internal/shared/discovered-definition'
import { resolveEffectiveViteHubServerImports } from '../internal/shared/vitehub-server-imports'
import { normalizeSandboxDefinitionOptions, resolveNitroSandboxScanDirs } from './sandbox-config'

import type { Nitro } from 'nitro/types'

export const sandboxGeneratedDir = generatedDirSegments('sandbox')

export function createNitroSandboxRegistryPath(rootDir: string, buildDir: string) {
  return resolve(rootDir, buildDir, ...sandboxGeneratedDir, 'nitro-registry.mjs')
}

export function createNitroSandboxPluginPath(rootDir: string, buildDir: string) {
  return resolve(rootDir, buildDir, ...sandboxGeneratedDir, 'nitro-plugin.ts')
}

export function createNitroSandboxDefinitionPath(rootDir: string, buildDir: string, name: string) {
  return resolve(rootDir, buildDir, ...sandboxGeneratedDir, 'definitions', `${sanitizeDefinitionFilename(name)}.mjs`)
}

export function createNitroSandboxPluginContents(file: string, registryFile: string) {
  return [
    'import { definePlugin as defineNitroPlugin } from "nitro"',
    'import { useRuntimeConfig } from "nitro/runtime-config"',
    'import type { AgentSandboxConfig } from "@vitehub/sandbox"',
    'import { setSandboxRuntimeConfig, setSandboxRuntimeRegistry } from "@vitehub/sandbox/runtime/state"',
    '',
    `import sandboxRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    '',
    'const sandboxNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin((nitroApp: any) => {',
    '  const applyRuntimeState = () => {',
    '    const runtimeConfig = useRuntimeConfig() as { sandbox?: false | AgentSandboxConfig }',
    '    setSandboxRuntimeConfig(runtimeConfig.sandbox)',
    '    setSandboxRuntimeRegistry(sandboxRegistry)',
    '  }',
    '',
    '  applyRuntimeState()',
    '',
    '  nitroApp.hooks.hook("request", () => {',
    '    applyRuntimeState()',
    '  })',
    '})',
    '',
    'export default sandboxNitroPlugin',
    '',
  ].join('\n')
}

async function createNitroSandboxDefinitionContents(
  definition: ReturnType<typeof discoverNitroSandboxDefinitions>[number],
  compiler: Awaited<ReturnType<typeof createDiscoveredDefinitionCompiler>>,
) {
  const source = await compiler.readSource(definition._meta.sourcePath)
  const bundle = await bundleSandboxDefinition(source, definition._meta.sourcePath)
  const options = normalizeSandboxDefinitionOptions(definition.name, await extractSandboxDefinitionOptions(definition.handler))

  return `export default ${JSON.stringify({ bundle, options })}\n`
}

export async function writeNitroSandboxRuntimeFiles(nitro: Nitro) {
  const registryFile = createNitroSandboxRegistryPath(nitro.options.rootDir, nitro.options.buildDir)
  const pluginFile = createNitroSandboxPluginPath(nitro.options.rootDir, nitro.options.buildDir)
  const scanDirs = resolveNitroSandboxScanDirs(nitro.options.rootDir, nitro.options.scanDirs)
  const definitions = discoverNitroSandboxDefinitions(scanDirs)
  const compiler = await createDiscoveredDefinitionCompiler({
    rootDir: nitro.options.rootDir,
    scanRoots: [nitro.options.rootDir],
    nitroImports: nitro.options.imports,
    featureImports: resolveEffectiveViteHubServerImports(nitro.options as Record<string, any>, 'sandbox'),
  })
  const registryDefinitions: Array<{ handler: string, name: string }> = []

  await mkdir(resolve(registryFile, '..'), { recursive: true })
  await Promise.all(definitions.map(async (definition) => {
    const file = createNitroSandboxDefinitionPath(nitro.options.rootDir, nitro.options.buildDir, definition.name)
    await writeFileIfChanged(file, await createNitroSandboxDefinitionContents(definition, compiler))
    registryDefinitions.push({ handler: file, name: definition.name })
  }))

  registryDefinitions.sort((left, right) => left.name.localeCompare(right.name))
  await writeFileIfChanged(registryFile, createRuntimeRegistryContents(registryFile, registryDefinitions))
  await writeFileIfChanged(pluginFile, createNitroSandboxPluginContents(pluginFile, registryFile))

  return {
    definitions,
    pluginFile,
    registryFile,
  }
}
