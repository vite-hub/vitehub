import { useKV } from "nitro/kv"
import parser from "#docs/parser"
import { createDocsParser } from "../markdown.ts"
import type { DocsDocument } from "../markdown.ts"

export const parseDocsDocument = createDocsParser(parser)
const parsed = new Map<string, Promise<DocsDocument | null>>()
const pending = new Map<string, Promise<DocsDocument | null>>()

/** Page JSON and search share in-flight parses; drafts always use the parser directly. */
export function loadDocsDocument(file: string, source = "docs", cache = true): Promise<DocsDocument | null> {
  const key = `${source}:${file}`
  const load = async () => {
    try {
      const content = await useKV(`assets:${source}`).getItem<string>(file)
      if (content === null) {
        parsed.delete(key)
        return null
      }
      return await parseDocsDocument(String(content))
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
