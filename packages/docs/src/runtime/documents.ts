import { useStorage } from "#imports";
import parser from "#docs/parser";
import { createDocsParser } from "../markdown.ts";
import type { DocsDocument } from "../markdown.ts";

export const parseDocsDocument = createDocsParser(parser);
const parsed = new Map<string, Promise<DocsDocument | null>>();
const pending = new Map<string, Promise<DocsDocument | null>>();

/** Page JSON and search share in-flight parses; drafts always use the parser directly. */
export function loadDocsDocument(file: string, cache = true): Promise<DocsDocument | null> {
  const load = async () => {
    try {
      const source = await useStorage("assets:docs").getItem<string>(file);
      if (source === null) {
        parsed.delete(file);
        return null;
      }
      return await parseDocsDocument(String(source));
    } catch (error) {
      parsed.delete(file);
      throw error;
    } finally {
      pending.delete(file);
    }
  };
  if (import.meta.dev) return load();
  const cached = parsed.get(file) ?? pending.get(file);
  if (cached) {
    if (cache) parsed.set(file, cached);
    return cached;
  }
  const document = load();
  pending.set(file, document);
  if (cache || import.meta.prerender) parsed.set(file, document);
  return document;
}
