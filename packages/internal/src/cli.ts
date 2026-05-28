export interface ViteHubCliStreams {
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

export interface ViteHubCliSpawnResult {
  exitCode: number | null
  signal?: NodeJS.Signals | null
}

export interface ViteHubCliSpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stderr?: "inherit" | "pipe"
  stdout?: "inherit" | "pipe"
}

export type ViteHubCliSpawn = (
  command: string,
  args: string[],
  options?: ViteHubCliSpawnOptions,
) => Promise<ViteHubCliSpawnResult>

export interface ViteHubCliContext extends ViteHubCliStreams {
  cwd: string
  env: NodeJS.ProcessEnv
  rootDir: string
  spawn: ViteHubCliSpawn
}

export interface ViteHubCliFeature {
  description?: string
  name: string
  run: (args: string[], context: ViteHubCliContext) => Promise<number | void> | number | void
  usage?: string
}

export interface ViteHubCliCommandNamespace {
  description?: string
  features: ViteHubCliFeature[]
  name: string
}

export interface ViteHubCliContributor {
  namespaces: ViteHubCliCommandNamespace[]
}

export type ViteHubCliContributorFactory = () => ViteHubCliContributor | undefined | Promise<ViteHubCliContributor | undefined>

export interface ViteHubCliPluginMetadata {
  cli?: ViteHubCliContributor | ViteHubCliContributorFactory
}

export interface ViteHubCliContributingPlugin {
  vitehub?: ViteHubCliPluginMetadata
}

async function resolveContributor(value: ViteHubCliPluginMetadata["cli"]): Promise<ViteHubCliContributor | undefined> {
  return typeof value === "function" ? await value() : value
}

export async function collectViteHubCliNamespaces(plugins: readonly unknown[]): Promise<ViteHubCliCommandNamespace[]> {
  const namespaces = new Map<string, ViteHubCliCommandNamespace>()

  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== "object") continue
    const metadata = (plugin as ViteHubCliContributingPlugin).vitehub
    const contributor = await resolveContributor(metadata?.cli)
    if (!contributor) continue

    for (const namespace of contributor.namespaces) {
      const existing = namespaces.get(namespace.name)
      if (!existing) {
        namespaces.set(namespace.name, { ...namespace, features: [...namespace.features] })
        continue
      }

      const features = new Map(existing.features.map(feature => [feature.name, feature]))
      for (const feature of namespace.features) {
        features.set(feature.name, feature)
      }
      existing.features = [...features.values()]
    }
  }

  return [...namespaces.values()]
}
