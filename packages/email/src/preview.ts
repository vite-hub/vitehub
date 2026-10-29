import { readFile } from "node:fs/promises"
import { relative } from "node:path"

import { renderEmailMarkdown } from "./markdown.ts"
import { discoverEmailTemplates } from "./templates.ts"

/** A rendered template. `file` is relative to the project root. */
export interface EmailPreview {
  file: string
  html: string
  template: string
  text: string
}

/** A template that the roots do not hold. */
export class EmailTemplateNotFoundError extends Error {
  readonly code = "EMAIL_TEMPLATE_NOT_FOUND"
  readonly status = 404
  readonly fix = "Pass the path under server/emails without `.md`."

  constructor(template: string, roots: readonly string[], rootDir: string, available: readonly string[]) {
    super(`Email template ${JSON.stringify(template)} was not found in ${roots.map(root => relative(rootDir, root) || ".").join(", ")}. ${available.length ? `Templates: ${available.join(", ")}.` : "No templates were found."}`)
  }
}

/**
 * Renders one template of `server/emails` without sending it. The name is the path under the roots without `.md`, the
 * same name as the `#vitehub/emails/<name>` import.
 */
export async function previewEmailTemplate(roots: readonly string[], rootDir: string, name: string, data: Record<string, unknown> = {}): Promise<EmailPreview> {
  const templates = await discoverEmailTemplates([...roots])
  const template = templates.find(entry => entry.name === name)
  if (!template) throw new EmailTemplateNotFoundError(name, roots, rootDir, templates.map(entry => entry.name))
  const rendered = await renderEmailMarkdown(await readFile(template.file, "utf8"), { data })
  return { file: relative(rootDir, template.file), html: rendered.html, template: template.name, text: rendered.text }
}
