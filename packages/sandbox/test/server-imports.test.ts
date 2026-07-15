import { describe, expect, it } from "vitest"

import { resolveEffectiveViteHubServerImports } from "../src/internal/shared/vitehub-server-imports.ts"

describe("resolveEffectiveViteHubServerImports", () => {
  it("still exposes sandbox imports for explicit sandbox setup", () => {
    expect(resolveEffectiveViteHubServerImports({}, "sandbox")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "runSandbox", from: "@vite-hub/sandbox" }),
    ]))
  })

  it("does not emit stale Prisma database imports", () => {
    expect(resolveEffectiveViteHubServerImports({ db: { orm: "prisma" } }, "db")).toEqual([
      expect.objectContaining({ name: "db", from: "@vite-hub/database/drizzle" }),
      expect.objectContaining({ name: "schema", from: "@vite-hub/database/drizzle" }),
    ])
  })

  it("emits the current Email Package imports", () => {
    expect(resolveEffectiveViteHubServerImports({}, "email")).toEqual([
      expect.objectContaining({ name: "createEmail", from: "@vite-hub/email" }),
      expect.objectContaining({ name: "defineEmail", from: "@vite-hub/email" }),
      expect.objectContaining({ name: "email", from: "@vite-hub/email" }),
      expect.objectContaining({ name: "EmailError", from: "@vite-hub/email" }),
      expect.objectContaining({ name: "renderEmailMarkdown", from: "@vite-hub/email/markdown" }),
      expect.objectContaining({ name: "EmailDriver", from: "@vite-hub/email", type: true }),
      expect.objectContaining({ name: "EmailMessage", from: "@vite-hub/email", type: true }),
      expect.objectContaining({ name: "EmailSendResult", from: "@vite-hub/email", type: true }),
      expect.objectContaining({ name: "RenderedEmailMarkdown", from: "@vite-hub/email/markdown", type: true }),
    ])
  })
})
