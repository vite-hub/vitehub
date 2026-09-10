import { renderMarkdownTemplate } from "./render.ts"

import type { RenderMarkdownFileOptions } from "./types.ts"

export type { RenderMarkdownFileOptions } from "./types.ts"

/** Read a local Markdown file and its relative fragments on each render. */
export async function renderMarkdownFile(path: string | URL, options: RenderMarkdownFileOptions = {}): Promise<string> {
  // Keep filesystem access out of the string renderer's module initialization.
  const { readFile, realpath } = await import("node:fs/promises")
  const { dirname, resolve } = await import("node:path")
  const sourceId = await realpath(path)
  const template = await readFile(sourceId, "utf8")

  return renderMarkdownTemplate(template, {
    data: options.data,
    maxImportDepth: options.maxImportDepth,
    sourceId,
    async resolveImport(specifier, importer) {
      const id = await realpath(resolve(dirname(importer), specifier))
      return { id, template: await readFile(id, "utf8") }
    },
  })
}
