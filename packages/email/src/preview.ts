import { readFile } from "node:fs/promises"
import { relative } from "node:path"

import type { ResultError } from "@vite-hub/runtime"
import type { RenderedEmail } from "./types.ts"
import type { EmailTemplate } from "./templates.ts"

import { emailErrorDiagnostics } from "./error-diagnostics.ts"
import { renderEmailMarkdown } from "./markdown.ts"
import { discoverEmailTemplates } from "./templates.ts"

/** A rendered template. `file` is relative to the project root. `subject` is set when the template has one. */
export interface EmailPreview {
  file: string
  html: string
  subject?: string
  template: string
  text: string
}

/** The error for a template that the roots do not hold. The `email.preview` operation answers 404 for it. */
export function emailTemplateNotFound(template: string, roots: readonly string[], rootDir: string, available: readonly string[]): ResultError<"EMAIL_TEMPLATE_NOT_FOUND"> & { status: number } {
  const error = emailErrorDiagnostics.EMAIL_TEMPLATE_NOT_FOUND({ available: available.join(", "), roots: roots.map(root => relative(rootDir, root) || ".").join(", "), template })
  return Object.assign(error, { status: 404 })
}

/**
 * Renders one template of `server/emails` without sending it. The name is the path under the roots without the
 * extension, the same name as the `#vitehub/emails/<name>` import. `renderVue` renders a `.vue` template.
 */
export async function previewEmailTemplate(roots: readonly string[], rootDir: string, name: string, data: Record<string, unknown> = {}, renderVue?: (template: EmailTemplate, data: Record<string, unknown>) => Promise<RenderedEmail>): Promise<EmailPreview> {
  const templates = await discoverEmailTemplates([...roots])
  const template = templates.find(entry => entry.name === name)
  if (!template || (template.file.endsWith(".vue") && !renderVue)) throw emailTemplateNotFound(name, roots, rootDir, templates.map(entry => entry.name))
  const rendered = template.file.endsWith(".vue") && renderVue
    ? await renderVue(template, data)
    : await renderEmailMarkdown(await readFile(template.file, "utf8"), { data })
  return { file: relative(rootDir, template.file), template: template.name, ...rendered }
}
