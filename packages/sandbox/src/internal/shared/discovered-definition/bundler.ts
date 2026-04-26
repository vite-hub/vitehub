import { builtinModules } from 'node:module'
import { dirname, relative, resolve as resolvePath } from 'pathe'
import { build, type Loader, type Plugin } from 'esbuild'

export interface DiscoveredDefinitionBundleOptions {
  filename: string
  source: string
  external?: string[]
  loader?: Loader
  packages?: 'bundle' | 'external'
  plugins?: Plugin[]
}

export interface DiscoveredDefinitionModuleGraph {
  entry: string
  modules: Record<string, string>
}

const builtinModuleSet = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
])

function resolveDefinitionLoader(options: DiscoveredDefinitionBundleOptions) {
  let loader = options.loader
  if (!loader) {
    const f = options.filename
    if (f.endsWith('.tsx')) loader = 'tsx'
    else if (f.endsWith('.jsx')) loader = 'jsx'
    else if (f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs')) loader = 'js'
    else loader = 'ts'
  }
  return loader
}

function isJsxDefinitionLoader(options: DiscoveredDefinitionBundleOptions) {
  const loader = resolveDefinitionLoader(options)
  return loader === 'tsx' || loader === 'jsx'
}

export async function bundleDiscoveredDefinitionModule(options: DiscoveredDefinitionBundleOptions) {
  const result = await build({
    stdin: {
      contents: options.source,
      loader: resolveDefinitionLoader(options),
      resolveDir: dirname(options.filename),
      sourcefile: options.filename,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    logLevel: 'silent',
    jsx: isJsxDefinitionLoader(options) ? 'automatic' : undefined,
    jsxImportSource: isJsxDefinitionLoader(options) ? 'react' : undefined,
    packages: options.packages === 'external' ? 'external' : undefined,
    external: [...builtinModuleSet, ...(options.external || [])],
    plugins: options.plugins,
  })

  const output = result.outputFiles?.[0]?.text
  if (!output)
    throw new Error(`[vitehub] Failed to bundle discovered definition "${options.filename}".`)

  return output
}

export async function bundleDiscoveredDefinitionModuleGraph(
  options: DiscoveredDefinitionBundleOptions,
): Promise<DiscoveredDefinitionModuleGraph> {
  const outdir = resolvePath(dirname(options.filename), '.vitehub-discovered-definition')
  const result = await build({
    stdin: {
      contents: options.source,
      loader: resolveDefinitionLoader(options),
      resolveDir: dirname(options.filename),
      sourcefile: options.filename,
    },
    bundle: true,
    splitting: true,
    entryNames: 'definition',
    chunkNames: 'chunks/[name]-[hash]',
    outdir,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    logLevel: 'silent',
    jsx: isJsxDefinitionLoader(options) ? 'automatic' : undefined,
    jsxImportSource: isJsxDefinitionLoader(options) ? 'react' : undefined,
    packages: options.packages === 'external' ? 'external' : undefined,
    external: [...builtinModuleSet, ...(options.external || [])],
    plugins: options.plugins,
  })

  const modules = Object.fromEntries((result.outputFiles || []).map((outputFile) => {
    return [relative(outdir, outputFile.path), outputFile.text]
  }))

  if (!modules['definition.js']) {
    throw new Error(`[vitehub] Failed to bundle discovered definition graph "${options.filename}".`)
  }

  return {
    entry: 'definition.js',
    modules,
  }
}
