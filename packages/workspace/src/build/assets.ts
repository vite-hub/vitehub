import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createViteHubEnvImportAliases } from "@vite-hub/internal/build/vite"
import { createImportPath } from "@vite-hub/internal/build/paths"
import { renderMarkdownTemplate } from "@vite-hub/markdown-template"
import { parseMarkdownTemplateRequest } from "@vite-hub/markdown-template/internal/vite"
import { resolveModulePath } from "exsolve"
import { createJiti } from "jiti"

import { syncWorkspaceDefinition } from "../lifecycle.ts"
import { normalizeSafeWorkspacePath } from "../core/path.ts"
import { createMemoryWorkspaceStore } from "../storage/memory.ts"

import type { DiscoveredWorkspaceDefinition } from "./discovery.ts"
import type { ResolvedWorkspaceModuleOptions, WorkspaceContent, WorkspaceDefinitionInput, WorkspaceStore } from "../core/types.ts"
import type { TransformOptions } from "jiti"

export interface WorkspaceAssetFile {
  content: WorkspaceContent
  mediaType?: string
  metadata?: Record<string, unknown>
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

function generatedViteHubImportAliases(rootDir: string) {
  const aliases: Record<string, string> = {}
  for (const [id, path] of Object.entries(createViteHubEnvImportAliases(rootDir))) {
    if (existsSync(path)) aliases[id] = path
  }
  return aliases
}

const rawImportVirtualModulePrefix = "vitehub:workspace-raw:"

type StaticTextImportKind = "markdown-template" | "raw"

interface BabelSourceDeclarationPath {
  node: { source?: { type?: string, value?: unknown } | null }
}

function staticTextImport(specifier: string): { kind: StaticTextImportKind, path: string } | undefined {
  const markdownTemplate = parseMarkdownTemplateRequest(specifier)
  if (markdownTemplate) return { kind: "markdown-template", path: markdownTemplate.path }
  const queryIndex = specifier.indexOf("?")
  if (queryIndex === -1 || !/(?:^|&)raw(?:&|$)/.test(specifier.slice(queryIndex + 1))) return

  return { kind: "raw", path: specifier.slice(0, queryIndex) }
}

function createRawImportTransformPlugin(importer: string | undefined) {
  function rewriteRawSpecifier(path: BabelSourceDeclarationPath) {
    if (!importer || path.node.source?.type !== "StringLiteral" || typeof path.node.source.value !== "string") return
    const textImport = staticTextImport(path.node.source.value)
    if (!textImport) return

    const reference = Buffer.from(JSON.stringify([importer, textImport.path, textImport.kind])).toString("base64url")
    path.node.source.value = `${rawImportVirtualModulePrefix}${reference}`
  }

  return () => ({
    visitor: {
      ExportAllDeclaration: rewriteRawSpecifier,
      ExportNamedDeclaration: rewriteRawSpecifier,
      ImportDeclaration: rewriteRawSpecifier,
    },
  })
}

function createWorkspaceDefinitionTransform() {
  const transformer = createJiti(import.meta.url, { fsCache: false })
  return (options: TransformOptions) => ({
    code: transformer.transform({
      ...options,
      babel: {
        ...options.babel,
        plugins: [
          ...(Array.isArray(options.babel?.plugins) ? options.babel.plugins : []),
          createRawImportTransformPlugin(options.filename),
        ],
      },
    }),
  })
}

function resolveWorkspaceRawSpecifier(path: string, rootDir: string): string {
  if (path.startsWith("/@fs/")) return path.slice("/@fs/".length)
  if (!path.startsWith("/")) return path

  const rootRelativePath = path.slice(1)
  const publicPath = join(rootDir, "public", rootRelativePath)
  return existsSync(publicPath) ? publicPath : join(rootDir, rootRelativePath)
}

export function createWorkspaceDefinitionLoader(rootDir: string, alias: Record<string, string> = {}) {
  let loader: ReturnType<typeof createJiti>
  const virtualModules = new Proxy<Record<string, unknown>>(Object.create(null), {
    get(_target, id) {
      if (typeof id !== "string" || !id.startsWith(rawImportVirtualModulePrefix)) return
      const reference = id.slice(rawImportVirtualModulePrefix.length)
      const [importer, path, kind = "raw"] = JSON.parse(Buffer.from(reference, "base64url").toString("utf8")) as [string, string, StaticTextImportKind?]
      const specifier = resolveWorkspaceRawSpecifier(path, rootDir)
      const resolved = loader.esmResolve(specifier, pathToFileURL(importer).href)
      const templatePath = fileURLToPath(resolved)
      const template = readFileSync(templatePath, "utf8")
      return {
        __esModule: true,
        default: kind === "markdown-template"
          ? (data: Record<string, unknown> = {}) => renderMarkdownTemplate(template, {
              data,
              sourceId: templatePath,
              resolveImport(specifier, importer) {
                const importedPath = resolve(dirname(importer), specifier)
                try {
                  return { id: importedPath, template: readFileSync(importedPath, "utf8") }
                }
                catch (error) {
                  if ((error as NodeJS.ErrnoException).code === "ENOENT") return
                  throw error
                }
              },
            })
          : template,
      }
    },
    has(_target, id) {
      return typeof id === "string" && id.startsWith(rawImportVirtualModulePrefix)
    },
  })

  loader = createJiti(import.meta.url, {
    alias: { ...alias, ...generatedViteHubImportAliases(rootDir) },
    fsCache: false,
    moduleCache: false,
    transform: createWorkspaceDefinitionTransform(),
    virtualModules,
  })
  return loader
}

export async function loadDiscoveredWorkspaceDefinition(
  loader: ReturnType<typeof createJiti>,
  definition: DiscoveredWorkspaceDefinition,
): Promise<WorkspaceDefinitionInput> {
  const mod = await loader.import(definition.path) as { default?: WorkspaceDefinitionInput }
  if (!mod.default) throw new TypeError(`[vitehub] Workspace definition "${definition.name}" has no default export.`)
  return mod.default
}

function runtimeAssetsModulePath() {
  const fromSource = resolveModulePath("../runtime/assets", {
    extensions: [".ts", ".mts"],
    from: import.meta.url,
    try: true,
  })
  return fromSource ?? resolveModulePath("@vite-hub/workspace/internal/runtime/assets", {
    extensions: [".js", ".mjs"],
    from: import.meta.url,
  })
}

export async function collectWorkspaceStoreAssetBundle(name: string, store: WorkspaceStore): Promise<WorkspaceAssetBundle> {
  const entries = (await store.glob("**/*")).filter(entry => entry.type === "file")
  const files: WorkspaceAssetFile[] = []
  for (const entry of entries) {
    const path = normalizeSafeWorkspacePath(entry.path)
    const file = await store.readFile(path)
    if (file) {
      files.push({ content: file.content, mediaType: file.mediaType, metadata: file.metadata, path })
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
  const workspaceConfigLoader = createWorkspaceDefinitionLoader(rootDir)
  for (const definition of definitions) {
    if (!shouldBundleWorkspaceAssets(options.assets, definition.name)) continue

    const workspace = await loadDiscoveredWorkspaceDefinition(workspaceConfigLoader, definition)

    const store = createMemoryWorkspaceStore()
    await syncWorkspaceDefinition({
      ...workspace,
      name: definition.name,
      rootDir: workspace.rootDir || rootDir,
      sourceRootDir: workspace.sourceRootDir ?? definition.sourceRootDir,
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
        return `      ${JSON.stringify(file.path)}: { load: async () => (await import(${JSON.stringify(importPath)})).default, mediaType: ${JSON.stringify(file.mediaType)}, metadata: ${JSON.stringify(file.metadata)} },`
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
