import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'pathe'
import type { Nitro } from 'nitro/types'
import { installCloudflareWranglerFinalizer } from './cloudflare-wrangler'
import { ensureNitroImports } from './nitro-imports'
import { applyServerImportsToNitro } from './server-imports'

export type ServerImport = {
  name: string
  from: string
  as?: string
  type?: boolean
  meta?: Record<string, unknown>
}

export interface FeatureManifest {
  alias: string
  aliasPath: string
  imports?: ServerImport[]
  typeTemplate?: {
    filename: string
    contents: string
  }
  nitroPlugin?: string
}

export interface GeneratedArtifact {
  key: string
  filename: string
  contents?: string
  getContents?: (artifacts: ReadonlyMap<string, EmittedArtifact>) => string | Promise<string>
}

export interface EmittedArtifact extends GeneratedArtifact {
  contents: string
  dst: string
}

export interface FeatureAliasRegistration {
  key: string
  value?: string
  artifactKey?: string
}

export interface FeatureHandlerRegistration {
  route: string
  method?: string
  handler?: string
  artifactKey?: string
}

export interface FeatureRuntimePlan {
  manifest: FeatureManifest
  aliases?: FeatureAliasRegistration[]
  artifacts?: GeneratedArtifact[]
  handlers?: FeatureHandlerRegistration[]
  extendNitro?: (target: Nitro['options'] & Record<string, unknown>, artifacts: ReadonlyMap<string, EmittedArtifact>) => void | Promise<void>
  onCompiled?: (nitro: Nitro, artifacts: ReadonlyMap<string, EmittedArtifact>) => void | Promise<void>
}

async function resolveArtifactContents(
  artifact: GeneratedArtifact,
  emitted: ReadonlyMap<string, EmittedArtifact>,
) {
  if (typeof artifact.getContents === 'function')
    return await artifact.getContents(emitted)
  return artifact.contents || ''
}

function resolvePlanAlias(
  alias: FeatureAliasRegistration,
  artifacts: ReadonlyMap<string, EmittedArtifact>,
) {
  if (alias.artifactKey) {
    const artifact = artifacts.get(alias.artifactKey)
    if (!artifact)
      throw new Error(`[vitehub] Missing emitted artifact "${alias.artifactKey}" for alias "${alias.key}".`)
    return artifact.dst
  }
  if (typeof alias.value === 'string')
    return alias.value
  throw new Error(`[vitehub] Alias "${alias.key}" must define either value or artifactKey.`)
}

function addPlanAliases(target: { alias?: Record<string, string> }, aliases: FeatureAliasRegistration[], artifacts: ReadonlyMap<string, EmittedArtifact>) {
  target.alias ||= {}
  for (const alias of aliases)
    target.alias[alias.key] = resolvePlanAlias(alias, artifacts)
}

function addPlanHandlers(target: { handlers?: Nitro['options']['handlers'] }, handlers: FeatureHandlerRegistration[], artifacts: ReadonlyMap<string, EmittedArtifact>) {
  target.handlers ||= []
  for (const handler of handlers) {
    const resolvedHandler = handler.artifactKey
      ? artifacts.get(handler.artifactKey)?.dst
      : handler.handler
    if (!resolvedHandler)
      throw new Error(`[vitehub] Missing handler for route "${handler.route}".`)

    target.handlers.push({
      route: handler.route,
      method: handler.method as typeof target.handlers[number]['method'],
      handler: resolvedHandler,
    })
  }
}

function getStableNitroRuntimeDir(nitro: Nitro) {
  return join(nitro.options.rootDir, '.vitehub', 'nitro-runtime')
}

export async function emitNitroArtifacts(nitro: Nitro, artifacts: GeneratedArtifact[] = []): Promise<Map<string, EmittedArtifact>> {
  const emitted = new Map<string, EmittedArtifact>()
  for (const artifact of artifacts) {
    const contents = await resolveArtifactContents(artifact, emitted)
    const path = join(getStableNitroRuntimeDir(nitro), artifact.filename)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
    emitted.set(artifact.key, {
      ...artifact,
      contents,
      dst: path,
    })
  }
  return emitted
}

export async function registerNitroFeature(nitro: Nitro, registration: FeatureManifest) {
  nitro.options.alias ||= {}
  nitro.options.alias[registration.alias] = registration.aliasPath

  if (registration.nitroPlugin) {
    nitro.options.plugins ||= []
    if (!nitro.options.plugins.includes(registration.nitroPlugin))
      nitro.options.plugins.push(registration.nitroPlugin)
  }

  ensureNitroImports(nitro)
  if (registration.imports?.length && nitro.options.imports !== false) {
    applyServerImportsToNitro(nitro.options, registration.imports)
  }

  if (registration.typeTemplate) {
    const typeTemplate = registration.typeTemplate
    nitro.hooks.hook('types:extend', async (types) => {
      const dtsPath = join(nitro.options.buildDir, 'types', typeTemplate.filename.replaceAll('/', '-'))
      await mkdir(dirname(dtsPath), { recursive: true })
      await writeFile(dtsPath, typeTemplate.contents)
      if (types.tsConfig) {
        types.tsConfig.include = types.tsConfig.include || []
        types.tsConfig.include.push(dtsPath)
      }
    })
  }
}

export async function applyFeaturePlanToNitro(nitro: Nitro, plan: FeatureRuntimePlan) {
  const emitted = await emitNitroArtifacts(nitro, plan.artifacts)

  await registerNitroFeature(nitro, plan.manifest)
  if (plan.aliases?.length)
    addPlanAliases(nitro.options, plan.aliases, emitted)
  if (plan.handlers?.length)
    addPlanHandlers(nitro.options, plan.handlers, emitted)
  if (plan.extendNitro)
    await plan.extendNitro(nitro.options as Nitro['options'] & Record<string, unknown>, emitted)
  installCloudflareWranglerFinalizer(nitro)
  if (plan.onCompiled) {
    nitro.hooks.hook('compiled', async () => {
      await plan.onCompiled?.(nitro, emitted)
    })
  }
}
