import { describe, expect, it } from "vitest"

import { parseConsoleWorkflowPayload } from "../src/console/runtime/client/workflow.ts"
import { isConsoleAttachmentPendingCleanup } from "../src/console/runtime/server/attachment-cleanup.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access-policy.ts"
import { usageQueryWindow } from "../src/console/runtime/server/usage.ts"
import { viteHubErrorDiagnostics } from "../src/error-diagnostics.ts"

import type { BlobStorage } from "@vite-hub/blob"

/** The codes that replaced errors marked as internal invariants in the Console and Logs sources. */
const codes = [
  "VITE_HUB_CONSOLE_ATTACHMENT_CLEANUP_QUARANTINED",
  "VITE_HUB_CONSOLE_AUTH_PLUGIN_MISSING",
  "VITE_HUB_CONSOLE_INVOCATION_FILES_LIMIT",
  "VITE_HUB_CONSOLE_JSON_INVALID",
  "VITE_HUB_CONSOLE_MCP_LIST_INCOMPLETE",
  "VITE_HUB_CONSOLE_NUMBER_REQUIRED",
  "VITE_HUB_LOGS_FILTER_UNSUPPORTED",
  "VITE_HUB_LOGS_SOURCE_PAGE_TOO_LARGE",
] as const

describe("vite-hub marked error codes", () => {
  it.each(codes)("%s has a fix and its own docs page", (code) => {
    // Each code takes its own params. One object that has all of them fits every code.
    const create = viteHubErrorDiagnostics[code] as (params: { filter: "text", limit: "entries", reason: "repeated-cursor", subject: "This value" }) => Error & { docs?: string, fix?: string }
    const error = create({ filter: "text", limit: "entries", reason: "repeated-cursor", subject: "This value" })
    expect(error.message).toMatch(/\S/)
    expect(error.fix).toMatch(/\S/)
    expect(error.docs).toBe(`https://vitehub.dev/docs/development/diagnostics/${code.toLowerCase()}`)
  })

  it("reports a Workflow payload that is not JSON with its code and fix", () => {
    expect(() => parseConsoleWorkflowPayload("{")).toThrow(expect.objectContaining({
      code: "VITE_HUB_CONSOLE_JSON_INVALID",
      fix: expect.stringContaining("double quotes"),
      message: "The payload is not valid JSON.",
    }))
  })

  it("reports a quarantined attachment cleanup record with its code and fix", async () => {
    const storage = {
      get: async () => [undefined, null],
      list: async ({ prefix }: { prefix: string }) => [undefined, { blobs: prefix.includes("quarantine") ? [{ pathname: `${prefix}batch/1` }] : [], hasMore: false }],
    } as unknown as Pick<BlobStorage, "get" | "list">
    await expect(isConsoleAttachmentPendingCleanup(storage, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      code: "VITE_HUB_CONSOLE_ATTACHMENT_CLEANUP_QUARANTINED",
      fix: expect.stringContaining("_vitehub/console/quarantine/"),
    })
  })

  it("answers a malformed usage cursor with VITE_HUB_R0115", () => {
    expect(() => usageQueryWindow({ cursor: "not base64!" })).toThrow(expect.objectContaining({ code: "VITE_HUB_R0115", status: 400 }))
  })

  it("raises INTERNAL_INVARIANT_FAILED for an access policy that generated output cannot pass", () => {
    expect(() => installConsoleAccess(JSON.parse("{\"mode\":\"bogus\"}"))).toThrow(expect.objectContaining({
      code: "INTERNAL_INVARIANT_FAILED",
      message: expect.stringContaining("generated Console output passes an access mode"),
    }))
  })
})
