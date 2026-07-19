import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { writeFileIfChanged } from '@vite-hub/internal/definition-catalog'
import { join, relative, resolve } from 'pathe'
import type { Plugin } from 'rollup'
import type {
  MutableCloudflareTarget,
  MutableNitroCloudflareTarget,
  MutableRollupTarget,
  WranglerContainer,
  WranglerDurableObjectBinding,
  WranglerMigration,
} from './internal/shared/cloudflare-target'

export const defaultCloudflareSandboxBinding = 'SANDBOX'
export const defaultCloudflareSandboxClassName = 'Sandbox'
export const defaultCloudflareSandboxMigrationTag = 'v1'
const defaultCloudflareSandboxMaxInstances = 12
const require = createRequire(import.meta.url)

function resolveCloudflareSandboxEntrypoint() {
  try {
    return require.resolve('@cloudflare/sandbox')
  }
  catch {
    throw new Error('[vitehub] The Cloudflare Sandbox provider requires @cloudflare/sandbox. Install a supported version before building.')
  }
}

function resolveCloudflareSandboxVersion() {
  const entry = resolveCloudflareSandboxEntrypoint()
  const pkg = require(join(entry, '..', '..', 'package.json'))
  if (typeof pkg?.version !== 'string')
    throw new Error('[vitehub] Could not resolve the installed @cloudflare/sandbox version.')
  return pkg.version
}

export type CloudflareSandboxEntrypointOptions = {
  binding?: string
  className?: string
  migrationTag?: string
  name?: string
}

function resolveCloudflareSandboxEntrypointOptions(options: CloudflareSandboxEntrypointOptions = {}) {
  return {
    binding: options.binding || defaultCloudflareSandboxBinding,
    className: options.className || defaultCloudflareSandboxClassName,
    migrationTag: options.migrationTag || defaultCloudflareSandboxMigrationTag,
    name: options.name || undefined,
  }
}

export function configureCloudflareSandbox(target: MutableCloudflareTarget, options: CloudflareSandboxEntrypointOptions = {}) {
  const { binding, className, migrationTag, name } = resolveCloudflareSandboxEntrypointOptions(options)
  const existingMigrations = target.cloudflare?.wrangler?.migrations
  const classIsMigrated = existingMigrations?.some(entry => entry.new_sqlite_classes?.includes(className))
  if (!classIsMigrated && existingMigrations?.some(entry => entry.tag === migrationTag)) {
    throw new Error(`[vitehub] Cloudflare migration tag ${JSON.stringify(migrationTag)} is already in use. Configure a unique sandbox migrationTag.`)
  }

  target.cloudflare ||= {}
  target.cloudflare.wrangler ||= {}
  target.cloudflare.wrangler.containers ||= []
  target.cloudflare.wrangler.durable_objects ||= {}
  target.cloudflare.wrangler.durable_objects.bindings ||= []
  target.cloudflare.wrangler.migrations ||= []

  const containers = target.cloudflare.wrangler.containers as WranglerContainer[]
  const image = './Dockerfile'
  if (!containers.some(entry => entry.class_name === className)) {
    containers.push({
      class_name: className,
      image,
      instance_type: 'lite',
      max_instances: defaultCloudflareSandboxMaxInstances,
      ...(name ? { name } : {}),
    })
  }

  const bindings = target.cloudflare.wrangler.durable_objects.bindings as WranglerDurableObjectBinding[]
  if (!bindings.some(entry => entry.name === binding && entry.class_name === className)) {
    bindings.push({
      name: binding,
      class_name: className,
    })
  }

  const migrations = target.cloudflare.wrangler.migrations as WranglerMigration[]
  if (!migrations.some(entry => Array.isArray(entry.new_sqlite_classes) && entry.new_sqlite_classes.includes(className))) {
    migrations.push({ tag: migrationTag, new_sqlite_classes: [className] })
  }
}

function createCloudflareSandboxRollupPlugin(options: CloudflareSandboxEntrypointOptions = {}): Plugin {
  const { className } = resolveCloudflareSandboxEntrypointOptions(options)
  const cloudflareSandboxEntrypoint = resolveCloudflareSandboxEntrypoint()
  const moduleId = 'virtual:vitehub-sandbox-cloudflare-exports'
  const resolvedModuleId = '\0virtual:vitehub-sandbox-cloudflare-exports'

  return {
    name: 'vitehub-sandbox-cloudflare-exports',
    buildStart() {
      this.emitFile({
        type: 'chunk',
        id: moduleId,
        fileName: 'sandbox-cloudflare-exports.mjs',
      })
    },
    resolveId(id) {
      if (id === moduleId)
        return resolvedModuleId
      if (id === '@cloudflare/sandbox')
        return cloudflareSandboxEntrypoint
    },
    load(id) {
      if (id === resolvedModuleId) {
        return [
          `import { Sandbox as CloudflareSandbox } from '@cloudflare/sandbox'`,
          ``,
          `export class ${className} extends CloudflareSandbox {}`,
          ``,
        ].join('\n')
      }
    },
    renderChunk(code, chunk) {
      if (!chunk.isEntry || chunk.fileName !== 'index.mjs')
        return null

      return {
        code: `${code}\nexport { ${className} } from './sandbox-cloudflare-exports.mjs'\n`,
        map: null,
      }
    },
  }
}

export function installCloudflareSandboxEntrypoint(target: MutableRollupTarget, options: CloudflareSandboxEntrypointOptions = {}) {
  const { className } = resolveCloudflareSandboxEntrypointOptions(options)
  target.rollupConfig ||= {}
  const plugins = Array.isArray(target.rollupConfig.plugins) ? target.rollupConfig.plugins : []
  target.rollupConfig.plugins = plugins
  if (plugins.some((plugin: unknown) => typeof plugin === 'object' && plugin !== null && 'name' in plugin && (plugin as { name?: string }).name === `vitehub-sandbox-cloudflare-exports:${className}`))
    return

  const plugin = createCloudflareSandboxRollupPlugin({ className })
  plugin.name = `vitehub-sandbox-cloudflare-exports:${className}`
  plugins.push(plugin)
}

export async function writeCloudflareSandboxDockerfile(serverDir: string) {
  const dockerfilePath = join(serverDir, 'Dockerfile')
  await writeFileIfChanged(dockerfilePath, `FROM docker.io/cloudflare/sandbox:${resolveCloudflareSandboxVersion()}\n`)
  return dockerfilePath
}

function relativeWranglerPath(from: string, to: string) {
  const path = relative(from, to).replace(/\\/g, '/')
  return path.startsWith('.') ? path : `./${path}`
}

export async function configureCloudflareSandboxNitro(
  targetValue: MutableNitroCloudflareTarget | undefined,
  rootDir: string,
  options: CloudflareSandboxEntrypointOptions = {},
) {
  const target = targetValue || {}
  const serverDir = resolve(rootDir, target.output?.serverDir || '.output/server')
  const resolvedOptions = resolveCloudflareSandboxEntrypointOptions(options)
  const existingContainer = target.cloudflare?.wrangler?.containers
    ?.find(entry => entry.class_name === resolvedOptions.className)

  configureCloudflareSandbox(target, resolvedOptions)
  const container = target.cloudflare!.wrangler!.containers!
    .find(entry => entry.class_name === resolvedOptions.className)!
  if (!existingContainer) {
    const appDockerfile = resolve(rootDir, 'Dockerfile')
    const dockerfile = existsSync(appDockerfile)
      ? appDockerfile
      : await writeCloudflareSandboxDockerfile(resolve(rootDir, '.vitehub/sandbox'))
    container.image = relativeWranglerPath(serverDir, dockerfile)
    container.image_build_context = relativeWranglerPath(serverDir, rootDir)
  }

  const wrangler = target.cloudflare!.wrangler!
  wrangler.compatibility_flags = Array.isArray(wrangler.compatibility_flags)
    ? [...wrangler.compatibility_flags]
    : []
  if (!wrangler.compatibility_flags.includes('nodejs_compat'))
    wrangler.compatibility_flags.push('nodejs_compat')

  installCloudflareSandboxEntrypoint(target, resolvedOptions)
  return target
}
