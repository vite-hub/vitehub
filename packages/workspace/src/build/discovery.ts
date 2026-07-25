import { readFileSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
} from "@vite-hub/internal/definition-catalog"

import { workspaceAgentPattern, workspaceConfigFileNames, workspaceConfigPattern, workspaceSuffixPattern } from "./workspace-config.ts"

import type { DefinitionCatalogSource } from "@vite-hub/internal/definition-catalog"

export interface DiscoveredWorkspaceDefinition {
  handler: string
  name: string
  path: string
  source?: string
  sourceRootDir?: string
}

type WorkspaceDefinitionCatalogSource = DefinitionCatalogSource<DiscoveredWorkspaceDefinition>

const configFileNameSet = new Set<string>(workspaceConfigFileNames)

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function isAgentConfig(file: string) {
  return /\bdefineAgent\s*\(/.test(stripComments(readFileSync(file, "utf8")))
}

function isWorkspaceAgentDefinition(file: string) {
  return /\bdefineAgent\s*\(\s*\{[\s\S]*?\bworkspace\s*:/.test(stripComments(readFileSync(file, "utf8")))
}

function collectDirectoriesWithConfig(root: string): Set<string> {
  const directories = new Set<string>()
  const walk = (current: string) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }

    if (entries.some(entry => entry.isFile() && configFileNameSet.has(entry.name))) {
      directories.add(current.replace(/\\/g, "/"))
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue
      walk(resolve(current, entry.name))
    }
  }
  walk(root)
  return directories
}

function resolveWorkspaceSourceRoot(file: string) {
  const directory = dirname(file)
  const workspaceDirectory = resolve(directory, "workspace")
  try {
    return statSync(workspaceDirectory).isDirectory() ? workspaceDirectory : directory
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return directory
    throw error
  }
}

function createWorkspaceDefinition(source: string, file: string, name: string): DiscoveredWorkspaceDefinition {
  return { handler: file, name, path: file, source, sourceRootDir: resolveWorkspaceSourceRoot(file) }
}

function serverWorkspaceSource(rootDir: string, serverDir = resolve(rootDir, "server")): WorkspaceDefinitionCatalogSource[] {
  const workspacesDir = resolve(serverDir, "workspaces")
  const agentsDir = resolve(serverDir, "agents")
  const directoryWorkspaceDirs = collectDirectoriesWithConfig(workspacesDir)

  const normalizeDirectoryName = (workspacesRoot: string, file: string) => {
    if (!workspaceConfigPattern.test(basename(file))) return
    const name = relative(workspacesRoot, dirname(file)).replace(/\\/g, "/")
    return name && name !== "." ? name : undefined
  }

  const isInsideDirectoryWorkspace = (file: string) => {
    let current = dirname(file).replace(/\\/g, "/")
    const stop = workspacesDir.replace(/\\/g, "/")
    while (current.startsWith(stop) && current !== stop) {
      if (directoryWorkspaceDirs.has(current)) return true
      current = dirname(current)
    }
    return false
  }

  const normalizeFlatName = (workspacesRoot: string, file: string) => {
    if (workspaceConfigPattern.test(basename(file))) return
    if (isInsideDirectoryWorkspace(file)) return
    return normalizePathDefinitionName(workspacesRoot, file)
  }

  return [
    createDirectoryDefinitionSource("server-workspaces-directory-config", [resolve(rootDir, "server")], "workspaces", {
      includeHidden: true,
      normalizeName: normalizeDirectoryName,
      createDefinition: ({ file, name }) => {
        if (isAgentConfig(file)) {
          throw new Error(`[vitehub] Workspace config "${file}" must use defineWorkspace(); defineAgent() belongs in server/agents/<name>/agent.ts.`)
        }
        return createWorkspaceDefinition("server-workspaces-directory-config", file, name)
      },
    }),
    createDirectoryDefinitionSource("server-agent-workspaces", [resolve(rootDir, "server")], "agents", {
      includeHidden: true,
      normalizeName(_agentsRoot, file) {
        if (!workspaceAgentPattern.test(basename(file))) return
        if (!isWorkspaceAgentDefinition(file)) return
        const name = relative(agentsDir, dirname(file)).replace(/\\/g, "/")
        return name && name !== "." ? name : undefined
      },
      createDefinition: ({ file, name }) => createWorkspaceDefinition("server-agent-workspaces", file, name),
    }),
    createDirectoryDefinitionSource("server-workspaces", [resolve(rootDir, "server")], "workspaces", {
      normalizeName: normalizeFlatName,
      createDefinition: ({ file, name }) => createWorkspaceDefinition("server-workspaces", file, name),
    }),
  ]
}

function viteWorkspaceSource(rootDir: string): WorkspaceDefinitionCatalogSource[] {
  return [
    createSuffixDefinitionSource("vite-workspace-suffix", [rootDir], workspaceSuffixPattern, (root, file) => normalizeSuffixDefinitionName(root, file, workspaceSuffixPattern, { stripPrefix: "src/" }), {
      createDefinition: ({ file, name }) => createWorkspaceDefinition("vite-workspace-suffix", file, name),
    }),
  ]
}

export function discoverServerWorkspaceDefinitions(rootDir: string): DiscoveredWorkspaceDefinition[] {
  return discoverDefinitions("workspace", [...serverWorkspaceSource(rootDir)])
}

export function discoverViteWorkspaceDefinitions(rootDir: string, options: { serverDirs?: string[], serverRootDir?: string } = {}): DiscoveredWorkspaceDefinition[] {
  const serverRoot = options.serverRootDir || rootDir
  const serverSources = options.serverDirs?.flatMap(serverDir => serverWorkspaceSource(serverRoot, serverDir))
    ?? serverWorkspaceSource(serverRoot)
  return mergeDefinitions(
    "workspace",
    discoverDefinitions("workspace", [...viteWorkspaceSource(rootDir)]),
    discoverDefinitions("workspace", serverSources),
  )
}

function createWorkspaceRegistryEntry(definition: DiscoveredWorkspaceDefinition, importExpression: string, override?: { store: unknown }): string {
  const renderedStore = override ? JSON.stringify(override.store) : undefined
  const defaultValue = [
    "...mod.default",
    ...(definition.sourceRootDir ? [`sourceRootDir: mod.default.sourceRootDir ?? ${JSON.stringify(definition.sourceRootDir)}`] : []),
    ...(renderedStore
      ? [
          `store: ${renderedStore}`,
          `__vitehubWorkspaceAgentOptions: mod.default.__vitehubWorkspaceAgentOptions && typeof mod.default.__vitehubWorkspaceAgentOptions.workspace === "object" ? { ...mod.default.__vitehubWorkspaceAgentOptions, workspace: { ...mod.default.__vitehubWorkspaceAgentOptions.workspace, store: ${renderedStore} } } : mod.default.__vitehubWorkspaceAgentOptions`,
        ]
      : []),
  ].join(", ")
  return [
    `  ${JSON.stringify(definition.name)}: async () => {`,
    `    const mod = await ${importExpression}`,
    definition.sourceRootDir || override ? `    return { ...mod, default: { ${defaultValue} } }` : "    return mod",
    "  },",
  ].join("\n")
}

export function createWorkspaceRegistryContents(registryFile: string, definitions: DiscoveredWorkspaceDefinition[], overrides?: Map<string, { store: unknown }>): string {
  const importExpression = (file: string) => {
    const importPath = relative(resolve(registryFile, ".."), file)
    return `import(${JSON.stringify(importPath.startsWith(".") ? importPath : `./${importPath}`)})`
  }
  return [
    "const registry = {",
    ...definitions.map(definition => createWorkspaceRegistryEntry(definition, importExpression(definition.handler), overrides?.get(definition.name))),
    "}",
    "export default registry",
    "",
  ].join("\n")
}

export function createWorkspaceVirtualRegistryContents(definitions: DiscoveredWorkspaceDefinition[]): string {
  return [
    "const registry = {",
    ...definitions.map(definition => createWorkspaceRegistryEntry(definition, `import(${JSON.stringify(pathToFileURL(definition.path).href)})`)),
    "}",
    "export default registry",
    "",
  ].join("\n")
}

export async function createWorkspaceManifest(definitions: DiscoveredWorkspaceDefinition[]): Promise<{ workspaces: Array<{ name: string }> }> {
  return {
    workspaces: definitions.map(definition => ({ name: definition.name })),
  }
}
