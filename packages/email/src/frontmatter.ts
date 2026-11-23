import { parseFrontmatter } from "@comark/html/parse"

import { emailErrorDiagnostics } from "./error-diagnostics.ts"

/** The body and the `subject:` frontmatter of a Markdown Email template. Other frontmatter keys are not allowed. */
export function parseEmailMarkdown(template: string): { content: string, subject?: string } {
  const { content, data } = parseFrontmatter(template)
  for (const [key, value] of Object.entries(data)) {
    if (key !== "subject") throw emailErrorDiagnostics.EMAIL_TEMPLATE_FRONTMATTER_INVALID({ key, problem: "key" })
    if (typeof value !== "string") throw emailErrorDiagnostics.EMAIL_TEMPLATE_FRONTMATTER_INVALID({ key, problem: "subject" })
  }
  return typeof data.subject === "string" ? { content, subject: data.subject } : { content }
}
