import { relative, resolve } from "node:path"

import { normalizeWorkspaceStoreOptions } from "./config.ts"
import { files as filesLoader } from "./loaders/files.ts"
import { getWorkspaceRuntimeConfig } from "./runtime/config.ts"
import { getWorkspaceHostedStoreLoader } from "./runtime/hosted-store-loader.ts"
import { createLocalWorkspaceStore } from "./stores/local.ts"
import { createMemoryWorkspaceStore } from "./stores/memory.ts"
import { WorkspaceError } from "./errors.ts"
import { normalizeWorkspacePath } from "./path.ts"

import type { LoaderContext, WorkspaceDefinition, WorkspaceSource, WorkspaceSourceItem, WorkspaceStore } from "./types.ts"

const workspaceConfigPattern = /^\.config\.(?:c|m)?[jt]s$/i
const declarationFilePattern = /\.d\.(?:c|m)?[jt]s$/i
const ignoredWorkspaceAssetDirs = new Set(["node_modules", "dist", ".nitro", ".output", ".nuxt", ".vercel", ".git", ".vitehub"])
const workspaceConfigFileNames = [".config.ts", ".config.mts", ".config.cts", ".config.js", ".config.mjs", ".config.cjs"]

function workspaceDirectory(rootDir: string, name: string) {
  return resolve(rootDir, "server", "workspaces", ...name.split("/"))
}

async function hasWorkspaceDirectoryConfig(directory: string) {
  const { access } = await import("node:fs/promises")
  for (const file of workspaceConfigFileNames) {
    try {
      await access(resolve(directory, file))
      return true
    }
    catch {}
  }
  return false
}

async function listWorkspaceDirectoryAssets(root: string, current = root): Promise<string[]> {
  const { readdir } = await import("node:fs/promises")
  const files: string[] = []
  const entries = await readdir(current, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const path = resolve(current, entry.name)
    if (entry.isDirectory()) {
      if (ignoredWorkspaceAssetDirs.has(entry.name)) continue
      files.push(...await listWorkspaceDirectoryAssets(root, path))
      continue
    }

    if (!entry.isFile()) continue
    if (workspaceConfigPattern.test(entry.name) || declarationFilePattern.test(entry.name)) continue
    files.push(normalizeWorkspacePath(relative(root, path)))
  }

  return files.sort()
}

async function createImplicitWorkspaceDirectorySource(definition: WorkspaceDefinition): Promise<WorkspaceSource | undefined> {
  const rootDir = definition.rootDir || process.cwd()
  const directory = workspaceDirectory(rootDir, definition.name)
  if (!await hasWorkspaceDirectoryConfig(directory)) return

  return {
    name: "directory-assets",
    async getKeys() {
      return await listWorkspaceDirectoryAssets(directory)
    },
    async getItem(key: string): Promise<WorkspaceSourceItem> {
      const { readFile, stat } = await import("node:fs/promises")
      const target = resolve(directory, key)
      const bytes = await readFile(target)
      const info = await stat(target)
      return {
        key,
        path: key,
        content: new Uint8Array(bytes),
        metadata: { mtime: info.mtimeMs },
      }
    },
  }
}

export function createWorkspaceStore(definition: WorkspaceDefinition): WorkspaceStore {
  if (definition.store && "readFile" in definition.store) return definition.store

  const rootDir = definition.rootDir || process.cwd()
  const runtimeConfig = getWorkspaceRuntimeConfig()
  const runtimeStore = runtimeConfig ? runtimeConfig.store : undefined
  const store = normalizeWorkspaceStoreOptions(definition.store || runtimeStore, {
    env: typeof process !== "undefined" ? process.env : {},
    hosting: typeof process !== "undefined" ? process.env.VITEHUB_HOSTING || process.env.NITRO_PRESET : undefined,
    rootDir,
  })

  if (store?.provider === "memory") return createMemoryWorkspaceStore()
  if (store?.provider === "cloudflare-artifacts" || store?.provider === "vercel-blob") {
    const loader = getWorkspaceHostedStoreLoader()
    if (!loader) throw new WorkspaceError(`[vitehub] Hosted workspace store "${store.provider}" is not available in this runtime.`)
    return loader(store, definition.name)
  }

  const root = store?.root
    ? resolve(rootDir, store.root)
    : runtimeConfig
      ? resolve(runtimeConfig.root, definition.name)
      : resolve(rootDir, ".vitehub/workspaces", definition.name)
  return createLocalWorkspaceStore(root)
}

export async function syncWorkspaceDefinition(definition: WorkspaceDefinition, store: WorkspaceStore): Promise<void> {
  const loaders = definition.loaders?.length ? definition.loaders : [filesLoader()]
  const implicitDirectorySource = await createImplicitWorkspaceDirectorySource(definition)
  const ctx: LoaderContext = {
    workspace: definition.name,
    rootDir: definition.rootDir || process.cwd(),
    sources: implicitDirectorySource ? [implicitDirectorySource, ...(definition.sources || [])] : definition.sources || [],
    store,
    parseData: async input => input.data,
    generateDigest: input => JSON.stringify(input),
    logger: console,
  }

  for (const loader of loaders) {
    await loader.load(ctx)
  }
  await store.snapshot({ name: "sync" })
  for (const publisher of definition.publish || []) {
    await publisher.publish({
      workspace: definition,
      store,
      rootDir: definition.rootDir || process.cwd(),
    })
  }
}
