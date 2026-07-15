import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  markdownTemplateQuery,
  markdownTemplateRuntimeSpecifier,
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
          alias: { [markdownTemplateRuntimeSpecifier]: markdownTemplateRuntime },
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
      this.addWatchFile(request.path)
      return {
        code: renderMarkdownTemplateModule(await readFile(request.path, "utf8")),
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
