import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  markdownTemplateQuery,
  markdownTemplateRuntimeSpecifier,
  bundleMarkdownTemplateImports,
  parseMarkdownTemplateRequest,
  renderMarkdownTemplateModule,
  renderMarkdownTemplateTypes,
} from "./internal/vite.ts"

import type { Plugin } from "vite"

const markdownTemplateRuntime = fileURLToPath(import.meta.resolve(markdownTemplateRuntimeSpecifier))

export function hubMarkdownTemplate(): Plugin {
  return {
    name: "@vite-hub/markdown-template/vite",
    enforce: "pre",
    config() {
      return {
        resolve: {
          alias: [{ find: /^@vite-hub\/markdown-template$/, replacement: markdownTemplateRuntime }],
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
      return `${resolved.id}?${markdownTemplateQuery}`
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
        code: renderMarkdownTemplateModule(template, request.path, imports),
        map: null,
      }
    },
    async configResolved(config) {
      const typesPath = resolve(config.root, ".vitehub", "types", "markdown-template.d.ts")
      await mkdir(dirname(typesPath), { recursive: true })
      await writeFile(typesPath, renderMarkdownTemplateTypes(), "utf8")
    },
  }
}
