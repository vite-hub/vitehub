import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { emailErrorDiagnostics } from "../src/error-diagnostics.ts"
import { previewEmailTemplate } from "../src/preview.ts"

const codes = {
  EMAIL_OUTBOX_DISABLED: emailErrorDiagnostics.EMAIL_OUTBOX_DISABLED(),
  EMAIL_OUTBOX_MESSAGE_NOT_FOUND: emailErrorDiagnostics.EMAIL_OUTBOX_MESSAGE_NOT_FOUND(),
  EMAIL_TEMPLATE_NOT_FOUND: emailErrorDiagnostics.EMAIL_TEMPLATE_NOT_FOUND({ available: "", roots: "server/emails", template: "welcome" }),
}

it("gives each code that replaced an error class a fix and its own docs page", () => {
  for (const [code, error] of Object.entries(codes)) {
    expect(error.code, code).toBe(code)
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/email/diagnostics/${code.toLowerCase()}`)
  }
})

it("throws EMAIL_TEMPLATE_NOT_FOUND with a 404 status and a fix for an unknown template", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-email-error-classes-"))
  try {
    await expect(previewEmailTemplate([join(root, "server/emails")], root, "welcome")).rejects.toMatchObject({
      code: "EMAIL_TEMPLATE_NOT_FOUND",
      fix: expect.stringContaining("server/emails/welcome.md"),
      message: "Email template \"welcome\" was not found in server/emails. No templates were found.",
      status: 404,
    })
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
