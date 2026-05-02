import { createHash } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { createImportPath } from "@vitehub/internal/build/paths"

import { normalizeSafeWorkspacePath } from "./path.ts"
import { registerWorkspace } from "./registry.ts"
import { useWorkspace } from "./use.ts"

import type { DiscoveredWorkspaceDefinition } from "./discovery.ts"
import type { ResolvedWorkspaceModuleOptions, Workspace, WorkspaceContent, WorkspaceDefinitionInput } from "./types.ts"

export interface WorkspaceAssetFile {
  content: WorkspaceContent
  path: string
}

export interface WorkspaceAssetBundle {
  files: WorkspaceAssetFile[]
  name: string
}

function shouldSyncWorkspace(syncOnBuild: boolean | string[] | undefined, name: string) {
  return syncOnBuild === true || (Array.isArray(syncOnBuild) && syncOnBuild.includes(name))
}

function assetModuleName(workspace: string, path: string) {
  const hash = createHash("sha256").update(`${workspace}\0${path}`).digest("hex").slice(0, 16)
  return `${hash}.mjs`
}

function serializeContent(content: WorkspaceContent) {
  if (typeof content === "string") return JSON.stringify(content)
  return `new Uint8Array(${JSON.stringify([...content])})`
}

export async function syncDiscoveredWorkspaces(
  definitions: DiscoveredWorkspaceDefinition[],
  rootDir: string,
  options: false | ResolvedWorkspaceModuleOptions,
): Promise<Workspace[]> {
  if (!options || !options.syncOnBuild) return []

  const workspaces: Workspace[] = []
  for (const definition of definitions) {
    if (!shouldSyncWorkspace(options.syncOnBuild, definition.name)) continue

    const mod = await import(pathToFileURL(definition.path).href) as { default?: WorkspaceDefinitionInput }
    if (!mod.default) throw new TypeError(`[vitehub] Workspace definition "${definition.name}" has no default export.`)

    registerWorkspace(definition.name, {
      ...mod.default,
      rootDir: mod.default.rootDir || rootDir,
    })

    const workspace = await useWorkspace(definition.name)
    await workspace.sync()
    workspaces.push(workspace)
  }

  return workspaces
}

export async function collectWorkspaceAssetBundle(workspace: Workspace): Promise<WorkspaceAssetBundle> {
  const entries = (await workspace.glob("**/*")).filter(entry => entry.type === "file")
  const files = await Promise.all(entries.map(async (entry) => {
    const path = normalizeSafeWorkspacePath(entry.path)
    return { content: await workspace.readFile(path, { encoding: "binary" }), path }
  }))

  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, name: workspace.name }
}

export async function collectWorkspaceAssetBundles(workspaces: Workspace[]): Promise<WorkspaceAssetBundle[]> {
  return await Promise.all(workspaces.map(workspace => collectWorkspaceAssetBundle(workspace)))
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
): string {
  return [
    "const registry = {",
    ...bundles.map((bundle) => {
      const entries = bundle.files.map((file) => {
        const modulePath = modulePaths.get(`${bundle.name}\0${file.path}`)
        const importPath = modulePath ? createImportPath(registryFile, modulePath) : pathToFileURL(file.path).href
        return `      ${JSON.stringify(file.path)}: () => import(${JSON.stringify(importPath)}),`
      })
      return [
        `  ${JSON.stringify(bundle.name)}: {`,
        `    async getKeys() { return ${JSON.stringify(bundle.files.map(file => file.path))} },`,
        "    async getItem(key) {",
        "      const modules = {",
        ...entries,
        "      }",
        "      const load = modules[key]",
        "      return load ? (await load()).default : null",
        "    },",
        "  },",
      ].join("\n")
    }),
    "}",
    "export default registry",
    "",
  ].join("\n")
}
