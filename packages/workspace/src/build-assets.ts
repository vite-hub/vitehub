import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { createImportPath } from "@vitehub/internal/build/paths"
import { listMatchingFiles } from "@vitehub/internal/definition-catalog"
import { resolveRuntimeEntry } from "@vitehub/internal/nitro"

import { syncWorkspaceDefinition } from "./lifecycle.ts"
import { normalizeSafeWorkspacePath } from "./path.ts"
import { createMemoryWorkspaceStore } from "./stores/memory.ts"
import { createWorkspace } from "./workspace.ts"
import { isWorkspaceAssetFile, workspaceConfigFileNames } from "./workspace-config.ts"

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

function shouldSyncWorkspace(syncOnBuild: boolean | string[] | undefined, name: string) {
  return syncOnBuild === undefined || syncOnBuild === true || (Array.isArray(syncOnBuild) && syncOnBuild.includes(name))
}

function assetModuleName(workspace: string, path: string) {
  const hash = createHash("sha256").update(`${workspace}\0${path}`).digest("hex").slice(0, 16)
  return `${hash}.mjs`
}

function serializeContent(content: WorkspaceContent) {
  if (typeof content === "string") return JSON.stringify(content)
  return `new Uint8Array(${JSON.stringify([...content])})`
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
    if (!shouldSyncWorkspace(options.syncOnBuild, definition.name)) continue

    const mod = await import(pathToFileURL(definition.path).href) as { default?: WorkspaceDefinitionInput }
    if (!mod.default) throw new TypeError(`[vitehub] Workspace definition "${definition.name}" has no default export.`)

    const workspace = createWorkspace({
      ...mod.default,
      name: definition.name,
      rootDir: mod.default.rootDir || rootDir,
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
    if (!shouldSyncWorkspace(options.syncOnBuild, definition.name)) continue

    const mod = await import(pathToFileURL(definition.path).href) as { default?: WorkspaceDefinitionInput }
    if (!mod.default) throw new TypeError(`[vitehub] Workspace definition "${definition.name}" has no default export.`)

    const store = createMemoryWorkspaceStore()
    await syncWorkspaceDefinition({
      ...mod.default,
      name: definition.name,
      rootDir: mod.default.rootDir || rootDir,
      store,
    }, store)
    bundles.push(await collectWorkspaceStoreAssetBundle(definition.name, store))
  }

  return bundles
}

export async function collectDirectoryWorkspaceAssetBundles(
  definitions: DiscoveredWorkspaceDefinition[],
  rootDir: string,
): Promise<WorkspaceAssetBundle[]> {
  const bundles: WorkspaceAssetBundle[] = []
  for (const definition of definitions) {
    const directory = definition.path ? dirname(definition.path) : resolve(rootDir, "server", "workspaces", ...definition.name.split("/"))
    if (!workspaceConfigFileNames.some(file => existsSync(resolve(directory, file)))) continue

    const files = await Promise.all(listMatchingFiles(directory, isWorkspaceAssetFile).map(async (file) => {
      const path = normalizeSafeWorkspacePath(relative(directory, file))
      return {
        content: await readFile(file),
        path,
      }
    }))
    files.sort((a, b) => a.path.localeCompare(b.path))
    bundles.push({ files, name: definition.name })
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
      const modulePath = join(workspaceDir, assetModuleName(bundle.name, file.path))
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
