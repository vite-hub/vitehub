import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'pathe'
import type { Plugin } from 'rollup'
import type {
  MutableCloudflareTarget,
  MutableRollupTarget,
  WranglerContainer,
  WranglerDurableObjectBinding,
  WranglerMigration,
} from './internal/shared/nitro-target'

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
    return '@cloudflare/sandbox'
  }
}

function resolveCloudflareSandboxVersion() {
  try {
    const entry = require.resolve('@cloudflare/sandbox')
    const pkg = require(join(entry, '..', '..', 'package.json'))
    return typeof pkg?.version === 'string' ? pkg.version : '0.7.0'
  }
  catch {
    return '0.7.0'
  }
}

export type CloudflareSandboxEntrypointOptions = {
  binding?: string
  className?: string
  migrationTag?: string
}

function resolveCloudflareSandboxEntrypointOptions(options: CloudflareSandboxEntrypointOptions = {}) {
  return {
    binding: options.binding || defaultCloudflareSandboxBinding,
    className: options.className || defaultCloudflareSandboxClassName,
    migrationTag: options.migrationTag || defaultCloudflareSandboxMigrationTag,
  }
}

export function configureCloudflareSandbox(target: MutableCloudflareTarget, options: CloudflareSandboxEntrypointOptions = {}) {
  const { binding, className, migrationTag } = resolveCloudflareSandboxEntrypointOptions(options)

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
    })
  }
  else {
    for (const container of containers) {
      if (container.class_name !== className)
        continue

      if (typeof container.image !== 'string')
        container.image = image

      if (typeof container.max_instances !== 'number' || container.max_instances < defaultCloudflareSandboxMaxInstances)
        container.max_instances = defaultCloudflareSandboxMaxInstances
    }
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
    migrations.push({
      tag: migrationTag,
      new_sqlite_classes: [className],
    })
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
  await writeFile(dockerfilePath, `FROM docker.io/cloudflare/sandbox:${resolveCloudflareSandboxVersion()}\n`)
}
