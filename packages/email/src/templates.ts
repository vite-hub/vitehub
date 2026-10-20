import * as v from "valibot"
import { readdir } from "node:fs/promises"
import { relative, resolve } from "node:path"

import { emailErrorDiagnostics } from "./error-diagnostics.ts"

async function listEmailTemplates(root: string, directory = root): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  }
  catch (error) {
    if (v.is(v.object({ code: v.literal("ENOENT") }), error)) return []
    throw error
  }

  const files: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) files.push(...await listEmailTemplates(root, path))
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path)
  }
  return files
}

function templateName(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, "/").replace(/\.md$/, "")
}

/** One Markdown template under a `server/emails` root. */
export interface EmailTemplate {
  file: string
  name: string
}

/** Lists Markdown templates under each root, recursively. The name is the path without `.md`. */
export async function discoverEmailTemplates(templatesRoots: string[]): Promise<EmailTemplate[]> {
  const templates = new Map<string, string>()
  for (const root of templatesRoots) {
    for (const file of await listEmailTemplates(root)) {
      const name = templateName(root, file)
      const existing = templates.get(name)
      if (existing) throw emailErrorDiagnostics.EMAIL_DUPLICATE_TEMPLATE({ name, sources: [existing, file] })
      templates.set(name, file)
    }
  }
  return [...templates].map(([name, file]) => ({ file, name }))
}
