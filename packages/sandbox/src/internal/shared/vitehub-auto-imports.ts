import { resolve as resolvePath } from 'pathe'
import type { Plugin } from 'vite'
import { createDiscoveredDefinitionCompiler } from './discovered-definition'
import type { NitroImportsOptions } from './server-imports'
import { dedupeServerImports } from './server-imports'
import {
  getViteHubFeatureServerImports,
  type ViteHubFeatureName,
} from './vitehub-server-imports'

export interface ViteHubDefinitionAutoImportsPluginOptions {
  rootDir?: string
  scanRoots?: string[]
  features?: ViteHubFeatureName[]
  include?: RegExp
  nitroImports?: NitroImportsOptions
}

const defaultFeatures = ['browser', 'queue', 'sandbox', 'workflow'] as const satisfies ViteHubFeatureName[]
const definitionPathPattern = /[/\\]server[/\\](?:browsers|queues|sandboxes|workflows)[/\\].+\.[cm]?[jt]s$/

function resolveFeatureImports(features: readonly ViteHubFeatureName[]) {
  return dedupeServerImports(features.flatMap(feature => getViteHubFeatureServerImports(feature)))
}

export function createViteHubDefinitionAutoImportsPlugin(
  options: ViteHubDefinitionAutoImportsPluginOptions = {},
): Plugin {
  const rootDir = resolvePath(options.rootDir || process.cwd())
  const scanRoots = (options.scanRoots?.length ? options.scanRoots : [rootDir]).map(root => resolvePath(root))
  const include = options.include || definitionPathPattern
  const featureImports = resolveFeatureImports(options.features?.length ? options.features : defaultFeatures)
  let compilerPromise: ReturnType<typeof createDiscoveredDefinitionCompiler> | undefined

  return {
    name: 'vitehub-definition-auto-imports',
    async transform(code, id) {
      if (!include.test(id))
        return

      compilerPromise ||= createDiscoveredDefinitionCompiler({
        rootDir,
        scanRoots,
        nitroImports: options.nitroImports ?? { presets: [] },
        featureImports,
      })

      const compiler = await compilerPromise
      const transformed = await compiler.injectSource(code, id)
      if (transformed === code)
        return

      return transformed
    },
  }
}
