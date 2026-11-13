import examples from "#docs/example-sources"
import parser, { githubRepo } from "#docs/parser"
import { defu } from "defu"
import { createDocsParser } from "../markdown.ts"
import { readDocsFile } from "./files.ts"
import type { DocsDocument } from "../markdown.ts"

// `#123` links to the site's issues unless the parser names another repository or turns references off.
const references = githubRepo ? { github: { references: { repo: githubRepo } } } : {}
export const parseDocsDocument = createDocsParser({ exampleSources: examples, ...parser, comarkUi: defu(parser.comarkUi, references) })
const parsed = new Map<string, Promise<DocsDocument | null>>()
const pending = new Map<string, Promise<DocsDocument | null>>()

/** Page JSON and search share in-flight parses; drafts always use the parser directly. */
export function loadDocsDocument(file: string, source = "docs", cache = true): Promise<DocsDocument | null> {
  const key = `${source}:${file}`
  const load = async () => {
    try {
      const content = await readDocsFile(source, file)
      if (content === null) {
        parsed.delete(key)
        return null
      }
      return await parseDocsDocument(content)
    } catch (error) {
      parsed.delete(key)
      throw error
    } finally {
      pending.delete(key)
    }
  }
  if (import.meta.dev) return load()
  const cached = parsed.get(key) ?? pending.get(key)
  if (cached) {
    if (cache) parsed.set(key, cached)
    return cached
  }
  const document = Promise.resolve().then(load)
  pending.set(key, document)
  if (cache || import.meta.prerender) parsed.set(key, document)
  return document
}
