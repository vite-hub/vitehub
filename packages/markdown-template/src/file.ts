import { renderMarkdownTemplate } from "./render.ts"

import type { RenderMarkdownFileOptions } from "./types.ts"

export type { RenderMarkdownFileOptions } from "./types.ts"

/** Read and render a local Markdown file on each call, preserving references as literal text. */
export async function renderMarkdownFile(path: string | URL, options: RenderMarkdownFileOptions = {}): Promise<string> {
  // Keep filesystem access out of the string renderer's module initialization.
  const { readFile, realpath } = await import("node:fs/promises")
  const sourceId = await realpath(path)
  const template = await readFile(sourceId, "utf8")
  return renderMarkdownTemplate(template, { data: options.data })
}
