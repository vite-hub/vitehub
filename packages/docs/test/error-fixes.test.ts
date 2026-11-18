import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { checkDocsLinks } from "../src/check-links.ts"
import { docsErrorDiagnostics } from "../src/error-diagnostics.ts"
import { resolveDocsSources } from "../src/manifest.ts"

it("gives each Docs code a fix and its own docs page", () => {
  for (const [code, create] of Object.entries(docsErrorDiagnostics)) {
    const error = (create as (params: { agent: string, details: string, file: string, mount: string, name: string, problems: string[], root: string }) => Error & { docs?: string, fix?: string })({ agent: "docs", details: "title: missing", file: "a.md", mount: "/a", name: "demo", problems: ["/a"], root: "/out" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/docs-site/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports a docs source mount with `..` with its code and fix", () => {
  expect(() => resolveDocsSources([{ mount: "/guide/../admin", source: "content" }])).toThrow(expect.objectContaining({
    code: "DOCS_SOURCE_MOUNT_INVALID",
    fix: expect.stringContaining("`mount`"),
  }))
})

it("reports a missing docs output folder with its code and fix", () => {
  const root = mkdtempSync(join(tmpdir(), "vitehub-docs-output-"))
  try {
    expect(() => checkDocsLinks({ dir: join(root, "missing"), siteUrl: "https://docs.test" })).toThrow(expect.objectContaining({
      code: "DOCS_OUTPUT_MISSING",
      fix: expect.stringContaining("checkDocsLinks({ dir })"),
    }))
  }
  finally {
    rmSync(root, { force: true, recursive: true })
  }
})
