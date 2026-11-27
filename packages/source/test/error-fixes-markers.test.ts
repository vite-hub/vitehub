import { gzipSync } from "node:zlib"

import { expect, it } from "vitest"
import * as v from "valibot"

import { createCollectionCursorCodec } from "../src/core/collection-cursor.ts"
import { sourceErrorDiagnostics } from "../src/error-diagnostics.ts"
import { parseGitHubArchive } from "../src/sources/github/archive.ts"

function archive(size: string): Uint8Array {
  const header = Buffer.alloc(512)
  header.write("repo/README.md", 0, "utf8")
  header.write(size, 124, "utf8")
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]))
}

it("gives SOURCE_GITHUB_ARCHIVE_INVALID a fix and its own docs page", () => {
  const error = sourceErrorDiagnostics.SOURCE_GITHUB_ARCHIVE_INVALID()
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe("https://vitehub.dev/docs/source/diagnostics/source_github_archive_invalid")
})

it("reports a GitHub archive entry with a size that is not octal with its code and fix", () => {
  expect(() => parseGitHubArchive(archive("12x"))).toThrow(expect.objectContaining({
    code: "SOURCE_GITHUB_ARCHIVE_INVALID",
    fix: expect.stringContaining("`github()`"),
  }))
})

it("reports a GitHub archive entry that is longer than the archive with its code", () => {
  expect(() => parseGitHubArchive(archive("77777"))).toThrow(expect.objectContaining({ code: "SOURCE_GITHUB_ARCHIVE_INVALID" }))
})

it.each(["a", "ab=", "YQ"])("answers the cursor %j, which is not canonical base64url, with SOURCE_R0023", async (cursor) => {
  await expect(createCollectionCursorCodec(v.string()).decode(cursor)).rejects.toMatchObject({ code: "SOURCE_R0023", reason: "malformed" })
})
