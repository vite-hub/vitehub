import { createHash } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { createImportPath } from "@vitehub/internal/build/paths"
import { resolveRuntimeEntry } from "@vitehub/internal/nitro"
import { createJiti } from "jiti"

import { syncWorkspaceDefinition } from "./lifecycle.ts"
import { normalizeSafeWorkspacePath } from "./path.ts"
import { createMemoryWorkspaceStore } from "./stores/memory.ts"
import { createWorkspace } from "./workspace.ts"

import type { DiscoveredWorkspaceDefinition } from "./discovery.ts"
import type { ResolvedWorkspaceModuleOptions, Workspace, WorkspaceContent, WorkspaceDefinitionInput, WorkspaceStore } from "./types.ts"

export interface WorkspaceAssetFile {
  content: WorkspaceContent
  mediaType?: string
  path: string
}

export interface WorkspaceAssetBundle {
  files: WorkspaceAssetFile[]
  name: string
}

export function shouldBundleWorkspaceAssets(assets: boolean | string[] | undefined, name: string) {
  return assets === undefined || assets === true || (Array.isArray(assets) && assets.includes(name))
}

function assetModuleName(workspace: string, path: string, content: WorkspaceContent) {
  const hash = createHash("sha256").update(`${workspace}\0${path}\0`).update(content).digest("hex").slice(0, 16)
  return `${hash}.mjs`
}

function serializeContent(content: WorkspaceContent) {
  if (typeof content === "string") return JSON.stringify(content)
  return `new Uint8Array(${JSON.stringify([...content])})`
}

const workspaceConfigLoader = createJiti(import.meta.url, { moduleCache: false })

async function importWorkspaceConfig(path: string): Promise<{ default?: WorkspaceDefinitionInput }> {
  return await workspaceConfigLoader.import(path)
}

function runtimeAssetsModulePath() {
  return resolveRuntimeEntry("./runtime/assets", "@vitehub/workspace/runtime/assets", import.meta.url)
}

export async function syncDiscoveredWorkspaces(
  definitions: DiscoveredWorkspaceDefinition[],
  rootDir: string,
  options: false | ResolvedWorkspaceModuleOptions,
): Promise<Workspace[]> {
  if (!options) return []

  const workspaces: Workspace[] = []
  for (const definition of definitions) {
    if (!shouldBundleWorkspaceAssets(options.assets, definition.name)) continue

    const mod = await importWorkspaceConfig(definition.path)
    if (!mod.default) throw new TypeError(`[vitehub] Workspace definition "${definition.name}" has no default export.`)

    const workspace = createWorkspace({
      ...mod.default,
      name: definition.name,
      rootDir: mod.default.rootDir || rootDir,
      sourceRootDir: mod.default.sourceRootDir ?? definition.sourceRootDir,
      store: { provider: "memory" },
    })

    await workspace.sync()
    workspaces.push(workspace)
  }

  return workspaces
}

export async function collectWorkspaceAssetBundle(workspace: Workspace): Promise<WorkspaceAssetBundle> {
  const entries = (await workspace.glob("**/*")).filter(entry => entry.type === "file")
  const files = await Promise.all(entries.map(async (entry) => {
    const path = normalizeSafeWorkspacePath(entry.path)
    return { content: await workspace.readFile(path, { encoding: "binary" }), mediaType: entry.mediaType, path }
  }))

  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, name: workspace.name }
}

export async function collectWorkspaceAssetBundles(workspaces: Workspace[]): Promise<WorkspaceAssetBundle[]> {
  return await Promise.all(workspaces.map(workspace => collectWorkspaceAssetBundle(workspace)))
}

export async function collectWorkspaceStoreAssetBundle(name: string, store: WorkspaceStore): Promise<WorkspaceAssetBundle> {
  const entries = (await store.glob("**/*")).filter(entry => entry.type === "file")
  const files: WorkspaceAssetFile[] = []
  for (const entry of entries) {
    const path = normalizeSafeWorkspacePath(entry.path)
    const file = await store.readFile(path)
    if (file) {
      files.push({ content: file.content, mediaType: file.mediaType, path })
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, name }
}

export async function syncDiscoveredWorkspaceAssetBundles(
  definitions: DiscoveredWorkspaceDefinition[],
  rootDir: string,
  options: false | ResolvedWorkspaceModuleOptions,
): Promise<WorkspaceAssetBundle[]> {
  if (!options) return []

  const bundles: WorkspaceAssetBundle[] = []
  for (const definition of definitions) {
    if (!shouldBundleWorkspaceAssets(options.assets, definition.name)) continue

    const mod = await importWorkspaceConfig(definition.path)
    if (!mod.default) throw new TypeError(`[vitehub] Workspace definition "${definition.name}" has no default export.`)

    const store = createMemoryWorkspaceStore()
    await syncWorkspaceDefinition({
      ...mod.default,
      name: definition.name,
      rootDir: mod.default.rootDir || rootDir,
      sourceRootDir: mod.default.sourceRootDir ?? definition.sourceRootDir,
      store,
    }, store)
    bundles.push(await collectWorkspaceStoreAssetBundle(definition.name, store))
  }

  return bundles
}

export async function writeWorkspaceAssetsRegistry(registryFile: string, bundles: WorkspaceAssetBundle[]): Promise<string> {
  const modulesDir = join(dirname(registryFile), "modules")
  await rm(modulesDir, { force: true, recursive: true })
  await mkdir(modulesDir, { recursive: true })

  const modulePaths = new Map<string, string>()
  for (const bundle of bundles) {
    const workspaceDir = join(modulesDir, encodeURIComponent(bundle.name))
    await mkdir(workspaceDir, { recursive: true })
    for (const file of bundle.files) {
      const modulePath = join(workspaceDir, assetModuleName(bundle.name, file.path, file.content))
      await writeFile(modulePath, `export default ${serializeContent(file.content)}\n`, "utf8")
      modulePaths.set(`${bundle.name}\0${file.path}`, modulePath)
    }
  }

  await mkdir(dirname(registryFile), { recursive: true })
  const contents = createWorkspaceAssetsRegistryContents(registryFile, bundles, modulePaths)
  await writeFile(registryFile, contents, "utf8")
  return contents
}

export function createWorkspaceAssetsRegistryContents(
  registryFile: string,
  bundles: WorkspaceAssetBundle[],
  modulePaths = new Map<string, string>(),
  assetsModulePath = runtimeAssetsModulePath(),
): string {
  return [
    `import { createWorkspaceAssets } from ${JSON.stringify(createImportPath(registryFile, assetsModulePath))}`,
    "",
    "const registry = {",
    ...bundles.map((bundle) => {
      const entries = bundle.files.map((file) => {
        const modulePath = modulePaths.get(`${bundle.name}\0${file.path}`)
        const importPath = modulePath ? createImportPath(registryFile, modulePath) : pathToFileURL(file.path).href
        return `      ${JSON.stringify(file.path)}: { load: async () => (await import(${JSON.stringify(importPath)})).default, mediaType: ${JSON.stringify(file.mediaType)} },`
      })
      return [
        `  ${JSON.stringify(bundle.name)}: createWorkspaceAssets({`,
        ...entries,
        "  }),",
      ].join("\n")
    }),
    "}",
    "export default registry",
    "",
  ].join("\n")
}
