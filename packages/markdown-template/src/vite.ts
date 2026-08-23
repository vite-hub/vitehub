import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"

import {
  markdownTemplateModuleQuery,
  markdownTemplateRuntimeSpecifier,
  markdownTemplateMaterializationPath,
  bundleMarkdownTemplateImports,
  parseMarkdownTemplateRequest,
  renderMarkdownTemplateModule,
  renderMarkdownTemplateTypes,
} from "./internal/vite.ts"

export { markdownTemplateMaterializationPath }

import type { Plugin } from "vite"

export interface HubMarkdownTemplateOptions {
  runtimeImport?: string
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

export function hubMarkdownTemplate(options: HubMarkdownTemplateOptions = {}): Plugin {
  const runtimeImport = options.runtimeImport || markdownTemplateRuntimeSpecifier
  const runtimeAlias = options.runtimeImport ? undefined : fileURLToPath(import.meta.resolve(markdownTemplateRuntimeSpecifier))

  return {
    name: "@vite-hub/markdown-template/vite",
    enforce: "pre",
    config() {
      if (!runtimeAlias) return
      return {
        resolve: {
          alias: [{ find: /^@vite-hub\/markdown-template$/, replacement: runtimeAlias }],
        },
      }
    },
    async resolveId(source, importer) {
      const request = parseMarkdownTemplateRequest(source)
      if (!request) return
      const resolved = await this.resolve(request.path, importer, { skipSelf: true })
      if (!resolved || resolved.external) {
        this.error(`[vitehub] Could not resolve Markdown template ${JSON.stringify(request.path)}${importer ? ` from ${JSON.stringify(importer)}` : ""}.`)
      }
      if (parseMarkdownTemplateRequest(resolved.id) && resolved.id.includes("?")) return resolved.id
      return `${resolved.id}?${markdownTemplateModuleQuery}`
    },
    async load(id) {
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
      const root = resolveViteHubProjectRoot(config.root)
      const typesPath = resolve(root, ".vitehub", "types", "markdown-template.d.ts")
      await Promise.all([
        writeFileIfChanged(typesPath, renderMarkdownTemplateTypes()),
        rm(resolve(root, ".vitehub", "types", "templates.d.ts"), { force: true }),
        rm(resolve(root, ".vitehub", "markdown-template", "templates.mjs"), { force: true }),
      ])
    },
  }
}
