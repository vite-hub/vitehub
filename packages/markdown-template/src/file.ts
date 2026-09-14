import { renderMarkdownTemplate } from "./render.ts"

import type { RenderMarkdownFileOptions } from "./types.ts"

export type { RenderMarkdownFileOptions } from "./types.ts"

/** Read and render a local Markdown file. */
export async function renderMarkdownFile(path: string | URL, options: RenderMarkdownFileOptions = {}): Promise<string> {
  // Keep filesystem access out of the string renderer's module initialization.
  const { readFile } = await import("node:fs/promises")
  const template = await readFile(path, "utf8")

  return renderMarkdownTemplate(template, {
    data: options.data,
  })
}
