import { describe, expect, it } from "vitest"
import { ViteHubError } from "@vite-hub/runtime"

import { runWorkflowProviderOperation, safeWorkflowName } from "../src/runtime/provider-operation.ts"

describe("Workflow provider operation errors", () => {
  it("keeps provider failures stable and redacts raw data", async () => {
    const cause = Object.assign(new Error("token=provider-secret"), {
      request: { url: "https://provider.example/runs/private-id" },
      response: { body: "private-body", status: 503 },
    })
    const error = await runWorkflowProviderOperation("vercel", "start", () => {
      throw cause
    }).catch(error => error)

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toMatchObject({
      cause,
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { operation: "start", provider: "vercel", status: 503 },
      message: "Workflow provider operation failed.",
      name: "ViteHubError",
    })
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { operation: "start", provider: "vercel", status: 503 },
      message: "Workflow provider operation failed.",
      name: "ViteHubError",
    })
    expect(JSON.stringify(error)).not.toContain("provider-secret")
    expect(JSON.stringify(error)).not.toContain("private-id")
    expect(JSON.stringify(error)).not.toContain("private-body")
  })

  it("does not serialize unallowlisted provider status values", async () => {
    const error = await runWorkflowProviderOperation("cloudflare", "get", async () => {
      throw { status: "401 token=secret", statusCode: 900 }
    }).catch(error => error)

    expect(error.details).toEqual({ operation: "get", provider: "cloudflare" })
    expect(JSON.stringify(error)).not.toContain("secret")
  })

  it("only carries explicit acknowledgement uncertainty across the provider boundary", async () => {
    const ambiguous = await runWorkflowProviderOperation("cloudflare", "create", async () => {
      throw new Error("connection closed")
    }, {
      acknowledgementUnknown: () => true,
    }).catch(error => error)
    const deterministic = await runWorkflowProviderOperation("cloudflare", "create", async () => {
      throw new Error("instance already exists")
    }).catch(error => error)

    expect(ambiguous.details).toEqual({ acknowledgement: "unknown", operation: "create", provider: "cloudflare" })
    expect(deterministic.details).toEqual({ operation: "create", provider: "cloudflare" })
  })

  it("preserves ViteHub and abort errors by exact identity", async () => {
    const custom = new ViteHubError("CUSTOM_WORKFLOW_FAILURE", "Custom failure.")
    const abort = new DOMException("cancelled", "AbortError")

    await expect(runWorkflowProviderOperation("vercel", "get-run", () => {
      throw custom
    })).rejects.toBe(custom)
    await expect(runWorkflowProviderOperation("cloudflare", "create", async () => {
      throw abort
    })).rejects.toBe(abort)
  })

  it("only accepts bounded opaque workflow names in error details", () => {
    expect(safeWorkflowName("daily-report.v2")).toBe("daily-report.v2")
    expect(safeWorkflowName("https://provider.example/private?id=secret")).toBeUndefined()
    expect(safeWorkflowName("person@example.com")).toBeUndefined()
    expect(safeWorkflowName("line\nbreak")).toBeUndefined()
    expect(safeWorkflowName("a".repeat(129))).toBeUndefined()
  })
})
