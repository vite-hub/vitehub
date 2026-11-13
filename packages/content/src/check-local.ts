import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"

import comarkUi from "comark-ui/html"
import type { JsonSchema } from "comark-content"
import type { SourceItem } from "@vite-hub/source"

import { checkContentDocuments, contentCheckResult, parseContentFiles } from "./check.ts"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { contentMarkdownPreset } from "./html.ts"

import type { ContentCheckOptions, ContentCheckResult } from "./check.ts"
import type { ContentDocumentUrl } from "./documents.ts"

/** `vitehub content check --dir`: check a folder of the working tree, without a running app. */
export interface ContentDirectoryCheckOptions extends ContentCheckOptions {
  /** The folder of the Source, such as `docs/content`. */
  dir: string
  /** The Source name in findings. Defaults to `default`. */
  source?: string
  /** The page URL pattern of the Source, as `contentSource(input, { url })` takes it. Defaults to the document path. */
  url?: ContentDocumentUrl
  /** The JSON Schema of the frontmatter, as `contentSource(input, { schema })` takes it. */
  schema?: JsonSchema
}

const textExtensions = /\.(?:md|markdown|json|ya?ml|txt|csv)$/i

/** The files below `dir`, without dot folders and `node_modules`, as a Source lists them. */
async function readFolder(root: string, dir = root): Promise<SourceItem<string, unknown, object>[]> {
  const items: SourceItem<string, unknown, object>[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      items.push(...await readFolder(root, path))
      continue
    }
    if (!entry.isFile()) continue
    const key = relative(root, path).split(sep).join("/")
    const bytes = await readFile(path)
    items.push({ key, path: key, content: textExtensions.test(entry.name) ? bytes.toString("utf8") : new Uint8Array(bytes) })
  }
  return items.sort((a, b) => a.key.localeCompare(b.key))
}

/** Run every rule of `content.check()` on a folder. It parses each file as `defineContent()` does without custom plugins. */
export async function checkContentDirectory(options: ContentDirectoryCheckOptions): Promise<ContentCheckResult> {
  const { dir, source = "default", url, schema, ...check } = options
  const info = await stat(dir).catch(() => undefined)
  if (!info?.isDirectory()) throw contentErrorDiagnostics.CONTENT_R0069({ message: `[vitehub] vitehub content check --dir needs a folder, and ${JSON.stringify(dir)} is not one.` })
  const files = await readFolder(dir)
  const markdown = { plugins: comarkUi(contentMarkdownPreset).plugins }
  const parsed = await parseContentFiles(source, files, schema ? { schema } : {}, { markdown }, true)
  const checked = checkContentDocuments({
    source,
    files,
    items: parsed.commit?.items ?? [],
    failures: parsed.failures,
    ...(schema ? { schema } : {}),
    ...(url === undefined ? {} : { url }),
    options: check,
  })
  return contentCheckResult([{ source, sha: null, pages: checked.pages }], checked.findings)
}
