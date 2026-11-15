import { afterEach, describe, expect, it, vi } from "vitest"
import { ViteHubError } from "@vite-hub/runtime"

import { getWorkflowProviderReason, runWorkflowProviderOperation, safeWorkflowName } from "../src/runtime/provider-operation.ts"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

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
    // The contract includes a redacted reason, so a client sees what the provider reported without raw data.
    expect(error).toMatchObject({
      cause,
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { operation: "start", provider: "vercel", reason: "Error: token=[redacted]", status: 503 },
      message: "Workflow provider operation failed.",
      name: "ViteHubError",
    })
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { operation: "start", provider: "vercel", reason: "Error: token=[redacted]", status: 503 },
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

  it("only carries the acknowledgement that the operation classifies", async () => {
    const ambiguous = await runWorkflowProviderOperation("cloudflare", "create", async () => {
      throw new Error("connection closed")
    }, {
      acknowledgement: () => "unknown",
    }).catch(error => error)
    const rejected = await runWorkflowProviderOperation("cloudflare", "create", async () => {
      throw new Error("(instance.already_exists) instance already exists")
    }, {
      acknowledgement: () => "rejected",
    }).catch(error => error)
    const unclassified = await runWorkflowProviderOperation("cloudflare", "create", async () => {
      throw new Error("instance already exists")
    }).catch(error => error)

    expect(ambiguous.details).toEqual({ acknowledgement: "unknown", operation: "create", provider: "cloudflare", reason: "Error: connection closed" })
    expect(rejected.details).toMatchObject({ acknowledgement: "rejected" })
    expect(unclassified.details).toEqual({ operation: "create", provider: "cloudflare", reason: "Error: instance already exists" })
  })

  it("passes normalized HTTP status to acknowledgement classification", async () => {
    let classifiedStatus: number | undefined
    const error = await runWorkflowProviderOperation("cloudflare", "create", () => {
      throw Object.assign(new Error("rejected"), { status: 403 })
    }, {
      acknowledgement: (_error, status) => {
        classifiedStatus = status
        return status === undefined ? "unknown" : "rejected"
      },
    }).catch(error => error)

    expect(classifiedStatus).toBe(403)
    expect(error.details).toEqual({ acknowledgement: "rejected", operation: "create", provider: "cloudflare", reason: "Error: rejected", status: 403 })
  })

  it("gives a short reason without URLs, file paths, tokens, or later lines", () => {
    const error = new TypeError([
      "'start' received an invalid workflow function at /home/dev/app/node_modules/.pnpm/workflow@5.2.3/dist/index.js (see https://provider.example/runs/private-id?token=abc)",
      "    at start (/home/dev/app/server/workflows/hello.ts:3:1)",
    ].join("\n"))
    const reason = getWorkflowProviderReason(error)

    expect(reason).toBe("TypeError: 'start' received an invalid workflow function at [path] (see [url]")
    expect(getWorkflowProviderReason(new Error(`run ${"a1b2".repeat(16)} failed: authorization=Bearer abc`))).toBe("Error: run [redacted] failed: authorization=[redacted]")
    expect(getWorkflowProviderReason(new Error("C:\\Users\\dev\\app\\.env.local is missing"))).toBe("Error: [path] is missing")
    expect(getWorkflowProviderReason(new Error("x".repeat(500)))?.length).toBeLessThanOrEqual(200)
    expect(getWorkflowProviderReason({ name: "bad name\nwith lines", message: "" })).toBeUndefined()
    expect(getWorkflowProviderReason("plain string")).toBeUndefined()
  })

  it("logs the full provider cause on a development server only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const cause = new Error("first line\nsecond line with detail")
    vi.stubEnv("NODE_ENV", "production")
    await runWorkflowProviderOperation("openworkflow", "run", () => {
      throw cause
    }).catch(() => {})
    expect(log).not.toHaveBeenCalled()

    vi.stubEnv("NODE_ENV", "development")
    await runWorkflowProviderOperation("openworkflow", "run", () => {
      throw cause
    }).catch(() => {})
    expect(log).toHaveBeenCalledWith("[vitehub:workflow] Workflow run failed in the openworkflow provider.", cause)
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
