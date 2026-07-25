import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import {
  markdownTemplateFileSuffix,
  markdownTemplateModuleQuery,
  markdownTemplateRegistryId,
  markdownTemplateRegistryPath,
  markdownTemplateRuntimeSpecifier,
  markdownTemplateMaterializationPath,
  bundleMarkdownTemplateImports,
  parseMarkdownTemplateRequest,
  renderMarkdownTemplateCatalogModule,
  renderMarkdownTemplateCatalogTypes,
  renderMarkdownTemplateModule,
  renderMarkdownTemplateTypes,
} from "./internal/vite.ts"

export { markdownTemplateMaterializationPath }

import type { BundledMarkdownTemplate, BundledMarkdownTemplateCatalogEntry } from "./internal/vite.ts"
import type { Plugin } from "vite"

export interface HubMarkdownTemplateOptions {
  runtimeImport?: string
}

interface MarkdownTemplateCatalogState {
  code: string
  names: string[]
  watchFiles: Set<string>
}

const ignoredTemplateDirectories = new Set([".git", ".vitehub", "dist", "node_modules"])
const resolvedMarkdownTemplateRegistryId = `\0${markdownTemplateRegistryId}`

async function listMarkdownTemplateFiles(root: string, directory = root): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }

  const files: string[] = []
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (!entry.name.startsWith(".") && !ignoredTemplateDirectories.has(entry.name)) {
        files.push(...await listMarkdownTemplateFiles(root, path))
      }
    }
    else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(markdownTemplateFileSuffix)) {
      files.push(path)
    }
  }
  return files
}

function markdownTemplateName(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, "/").replace(/\.md$/, "")
}

async function loadBundledMarkdownTemplate(path: string): Promise<BundledMarkdownTemplate | undefined> {
  try {
    return { id: path, template: await readFile(path, "utf8") }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}

async function createMarkdownTemplateCatalog(templatesRoot: string, runtimeImport: string): Promise<MarkdownTemplateCatalogState> {
  const entries: Record<string, BundledMarkdownTemplateCatalogEntry> = Object.create(null)
  const watchFiles = new Set<string>()

  for (const file of await listMarkdownTemplateFiles(templatesRoot)) {
    const bundled = await loadBundledMarkdownTemplate(file)
    if (!bundled) continue
    const imports = await bundleMarkdownTemplateImports(file, async (specifier, importer) => {
      const path = specifier === "." ? file : resolve(dirname(importer), specifier)
      const imported = await loadBundledMarkdownTemplate(path)
      if (imported) watchFiles.add(imported.id)
      return imported
    })
    const name = markdownTemplateName(templatesRoot, file)
    entries[name] = { ...bundled, imports }
    watchFiles.add(file)
  }

  const names = Object.keys(entries).sort()
  return {
    code: renderMarkdownTemplateCatalogModule(entries, runtimeImport),
    names,
    watchFiles,
  }
}

async function writeFileIfChanged(path: string, contents: string): Promise<void> {
  let current: string | undefined
  try {
    current = await readFile(path, "utf8")
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (current === contents) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, "utf8")
}

function isInside(directory: string, file: string): boolean {
  const path = relative(directory, file)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

export function hubMarkdownTemplate(options: HubMarkdownTemplateOptions = {}): Plugin {
  const runtimeImport = options.runtimeImport || markdownTemplateRuntimeSpecifier
  const runtimeAlias = options.runtimeImport ? undefined : fileURLToPath(import.meta.resolve(markdownTemplateRuntimeSpecifier))
  let root = process.cwd()
  let serverDirs: string[] | undefined
  let templatesRoot = resolve(root, "server", "templates")
  let registryPath = resolve(root, markdownTemplateRegistryPath)
  let catalogTypesPath = resolve(root, ".vitehub", "types", "templates.d.ts")
  let catalog: MarkdownTemplateCatalogState = {
    code: renderMarkdownTemplateCatalogModule({}, runtimeImport),
    names: [],
    watchFiles: new Set(),
  }

  const refreshCatalog = async () => {
    catalog = await createMarkdownTemplateCatalog(templatesRoot, runtimeImport)
    await Promise.all([
      writeFileIfChanged(registryPath, catalog.code),
      writeFileIfChanged(catalogTypesPath, renderMarkdownTemplateCatalogTypes(catalog.names)),
    ])
  }

  return {
    name: "@vite-hub/markdown-template/vite",
    enforce: "pre",
    config(config) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      if (!runtimeAlias) return
      return {
        resolve: {
          alias: [{ find: /^@vite-hub\/markdown-template$/, replacement: runtimeAlias }],
        },
      }
    },
    async resolveId(source, importer) {
      if (source === markdownTemplateRegistryId) return resolvedMarkdownTemplateRegistryId
      const request = parseMarkdownTemplateRequest(source)
      if (!request) return
      const resolved = await this.resolve(request.path, importer, { skipSelf: true })
      if (!resolved || resolved.external) {
        this.error(`[vitehub] Could not resolve Markdown template ${JSON.stringify(request.path)}${importer ? ` from ${JSON.stringify(importer)}` : ""}.`)
      }
      return `${resolved.id}?${markdownTemplateModuleQuery}`
    },
    async load(id) {
      if (id === resolvedMarkdownTemplateRegistryId) return catalog.code
      const request = parseMarkdownTemplateRequest(id)
      if (!request) return
      const template = await readFile(request.path, "utf8")
      const imports = await bundleMarkdownTemplateImports(request.path, async (specifier, importer) => {
        if (specifier === ".") return { id: request.path, template }
        const resolved = await this.resolve(specifier, importer, { skipSelf: true })
        if (!resolved || resolved.external) return
        this.addWatchFile(resolved.id)
        return { id: resolved.id, template: await readFile(resolved.id, "utf8") }
      })
      this.addWatchFile(request.path)
      return {
        code: renderMarkdownTemplateModule(template, request.path, imports, runtimeImport),
        map: null,
      }
    },
    async configResolved(config) {
      root = resolveViteHubProjectRoot(config.root)
      templatesRoot = resolve(serverDirs?.[0] ?? resolve(root, "server"), "templates")
      registryPath = resolve(root, markdownTemplateRegistryPath)
      catalogTypesPath = resolve(root, ".vitehub", "types", "templates.d.ts")
      const typesPath = resolve(root, ".vitehub", "types", "markdown-template.d.ts")
      await Promise.all([
        writeFileIfChanged(typesPath, renderMarkdownTemplateTypes()),
        refreshCatalog(),
      ])
    },
    async buildStart() {
      await refreshCatalog()
      for (const file of catalog.watchFiles) this.addWatchFile(file)
    },
    configureServer(server) {
      server.watcher.add(templatesRoot)
      const refreshForFile = async (file: string) => {
        if (!isInside(templatesRoot, file) && !catalog.watchFiles.has(file)) return
        await refreshCatalog()
        const module = await server.moduleGraph.getModuleById(resolvedMarkdownTemplateRegistryId)
        if (module) server.moduleGraph.invalidateModule(module)
        server.ws.send({ type: "full-reload" })
      }
      server.watcher.on("add", file => void refreshForFile(file).catch(error => server.config.logger.error(String(error))))
      server.watcher.on("unlink", file => void refreshForFile(file).catch(error => server.config.logger.error(String(error))))
    },
    async handleHotUpdate(context) {
      if (!catalog.watchFiles.has(context.file)) return
      await refreshCatalog()
      const module = await context.server.moduleGraph.getModuleById(resolvedMarkdownTemplateRegistryId)
      if (!module) return []
      context.server.moduleGraph.invalidateModule(module)
      return [module]
    },
  }
}
