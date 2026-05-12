import { describe, expect, it } from "vitest"
import { CIAuthError, CINotFoundError, CIRateLimitError, normalizeProviderError } from "../src/errors.ts"
import { createCIProvider, extractLikelyCIError } from "../src/index.ts"
import type { CILogLine } from "../src/types.ts"

describe("@vitehub/ci helpers", () => {
  it("creates supported providers", () => {
    expect(createCIProvider("cloudflare").id).toBe("cloudflare")
    expect(createCIProvider("vercel").id).toBe("vercel")
    expect(createCIProvider("github").id).toBe("github")
  })

  it("maps HTTP failures to typed errors", () => {
    expect(normalizeProviderError({ response: { status: 401, statusText: "Unauthorized" } }, "github")).toBeInstanceOf(CIAuthError)
    expect(normalizeProviderError({ response: { status: 404, statusText: "Not Found" } }, "github")).toBeInstanceOf(CINotFoundError)
    expect(normalizeProviderError({ response: { status: 429, statusText: "Too Many Requests" } }, "github")).toBeInstanceOf(CIRateLimitError)
  })

  it("extracts likely CI errors with context", () => {
    const lines: CILogLine[] = [
      { message: "install" },
      { message: "compile" },
      { message: "pnpm build" },
      { message: "SyntaxError: missing brace" },
      { message: "after" },
    ]
    expect(extractLikelyCIError(lines, { contextLines: 1 })).toBe("pnpm build\nSyntaxError: missing brace\nafter")
  })

  it("prefers matches near the end", () => {
    const lines: CILogLine[] = [
      { message: "TypeError: first" },
      { message: "middle" },
      { message: "wrangler error: latest" },
    ]
    expect(extractLikelyCIError(lines, { contextLines: 0 })).toBe("wrangler error: latest")
  })

  it("falls back to the last loaded lines", () => {
    const lines = Array.from({ length: 10 }, (_, index) => ({ message: `line ${index}` }))
    expect(extractLikelyCIError(lines, { fallbackLineCount: 3 })).toBe("line 7\nline 8\nline 9")
  })
})

