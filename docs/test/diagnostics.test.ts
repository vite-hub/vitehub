import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { docsSeoLimits } from "../../packages/docs/src/seo-audit"
import { readDiagnosticCodes } from "../modules/diagnostics/catalog"
import { diagnosticGroup, diagnosticPages, diagnosticPath, diagnosticSection, limitsSections, markdownText } from "../modules/diagnostics/pages"

import type { DiagnosticCode } from "../modules/diagnostics/catalog"

const root = resolve(import.meta.dirname, "../..")
const codes = readDiagnosticCodes(root)

function code(name: string): DiagnosticCode {
  const found = codes.find(candidate => candidate.code === name)
  if (!found) throw new Error(`Missing diagnostic ${name}`)
  return found
}

describe("diagnostic catalogs", () => {
  it("reads every code of the package catalogs and places each one in a docs section", () => {
    expect(codes.length).toBeGreaterThan(2000)
    expect(codes.filter(candidate => !diagnosticSection(candidate)).map(candidate => candidate.pkg)).toEqual([])
  })

  it("reads `why` and `fix`, with each template expression as a placeholder", () => {
    expect(code("QUEUE_DISABLED")).toMatchObject({ pkg: "queue", why: "Queue is disabled in this runtime.", fix: "In `vitehub()`, set `queue.provider` to the provider of the host, or remove `provider`. With `@vite-hub/queue` alone, do not pass `false` to `hubQueue()`, and set a `provider` that matches the host." })
    // A function `why` shows the most detailed text that it can return.
    expect(code("QUEUE_BINDING_NOT_FOUND").why).toBe("The Cloudflare queue binding \"<binding>\" is not in the Worker env.")
    expect(code("QUEUE_PROVIDER_FAILED").group).toBe("Runtime errors")
  })

  it("reads the `code(why, fix, docs, action)` helper of the Console catalog", () => {
    expect(code("CONSOLE_SIGNATURE_STALE")).toMatchObject({
      pkg: "vite-hub",
      why: "The request was signed more than 5 minutes before or after the app clock.",
      fix: "Sync the clock of the machine that signs, then send the request again.",
    })
  })

  it("reads the message that a call site passes to a numbered code", () => {
    expect(code("BLOB_R0001")).toMatchObject({ why: null, sites: [expect.objectContaining({ file: "packages/blob/src/drivers/cloudflare-native.ts", message: "R2 binding \"<binding>\" not found" })] })
  })

  it("reads the production shorthand catalogs", () => {
    expect(code("CONNECTIONS_STATE_MISMATCH")).toMatchObject({ pkg: "connections", file: "packages/connections/src/error-diagnostics.ts", why: "The callback has no `state` cookie of this browser, or the cookie does not match.", docsBase: "https://vitehub.dev/docs/connections/diagnostics" })
    expect(code("RUNTIME_R0001").file).toBe("packages/runtime/src/error-diagnostics.ts")
  })

  it("gives the package that the code prefix names a code that two catalogs declare", () => {
    expect(code("CONTENT_R0006").pkg).toBe("content")
  })

  it("keeps Agent MCP errors in their existing section alongside the new app MCP catalog", () => {
    for (const name of ["MCP_SERVER_FAILED", "MCP_TOOL_CALL_FAILED", "MCP_TOOL_CANCELLED", "MCP_TOOL_NOT_FOUND", "MCP_TOOL_TIMEOUT"]) {
      expect(code(name)).toMatchObject({ pkg: "agent", docsBase: "https://vitehub.dev/docs/agents/diagnostics" })
    }
    for (const name of ["MCP_B0001", "MCP_B0002", "MCP_B0003"]) {
      expect(code(name)).toMatchObject({ pkg: "mcp", docsBase: "https://vitehub.dev/docs/mcp/diagnostics" })
    }
  })

  it("names the `vitehub()` option in each fix that names an owner plugin", () => {
    // These fixes are about an owner plugin that the app adds itself, so `vitehub()` has no part in them.
    const ownerPluginOnly = new Set(["AUTH_B0001", "QUEUE_PLUGIN_INCOMPATIBLE"])
    const missing = codes
      .filter(candidate => /\bhub[A-Z]\w*\(/.test(candidate.fix ?? "") && !candidate.fix!.includes("vitehub(") && !ownerPluginOnly.has(candidate.code))
      .map(candidate => `${candidate.code}: ${candidate.fix}`)
    expect(missing).toEqual([])
  })
})

describe("catalog object references", () => {
  let fixture: string | undefined
  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true })
  })

  function readFixture(source: string) {
    fixture = mkdtempSync(resolve(tmpdir(), "diagnostic-catalog-"))
    const src = resolve(fixture, "packages/example/src")
    mkdirSync(src, { recursive: true })
    writeFileSync(resolve(src, "diagnostics.ts"), source)
    return readDiagnosticCodes(fixture)
  }

  it.each(["codes", "codes: definitions", "codes: alias"])("resolves %s without evaluating the catalog", (property) => {
    const found = readFixture(`
      const definitions = { EXAMPLE_FAILED: { why: "Failed.", fix: "Retry." } } as const;
      const codes = definitions;
      const alias = (codes satisfies Record<string, unknown>);
      defineErrors({ docs: "https://example.com/errors", ${property} });
    `)
    expect(found).toEqual([expect.objectContaining({ code: "EXAMPLE_FAILED", why: "Failed.", fix: "Retry." })])
  })

  it.each(["loadCodes()", "missing", "cycle"])("fails explicitly for unreadable codes: %s", (expression) => {
    expect(() => readFixture(`const cycle = cycle; defineDiagnostics({ codes: ${expression} });`))
      .toThrow("Cannot read diagnostic codes in packages/example/src/diagnostics.ts:1")
  })

  it("reads `why` and `fix` that a same-file helper takes by parameter name", () => {
    const found = readFixture(`
      const guide = "https://example.com/guide";
      const code = (why: string, fix: string, docs: string, action: string) => ({ why: () => why, fix, docs, data: { action } });
      function guidance(fix: string) { return { fix }; }
      defineDiagnostics({ codes: {
        EXAMPLE_FAILED: code("Failed.", \`Set \${guide}.\`, guide, "docs"),
        EXAMPLE_RETRY: guidance("Retry."),
        EXAMPLE_COMPUTED: code(reason, fixText, guide, "docs"),
        EXAMPLE_UNKNOWN: imported("Not read."),
      } });
    `)
    expect(found.map(({ code, why, fix }) => ({ code, why, fix }))).toEqual([
      { code: "EXAMPLE_COMPUTED", why: null, fix: null },
      { code: "EXAMPLE_FAILED", why: "Failed.", fix: "Set <guide>." },
      { code: "EXAMPLE_RETRY", why: null, fix: "Retry." },
      { code: "EXAMPLE_UNKNOWN", why: null, fix: null },
    ])
  })

  it.each(['docs: "https://example.com/guide#failed"', "docs"])("reads per-code URL overrides: %s", (property) => {
    const found = readFixture(`
      const docs = "https://example.com/guide#failed";
      const definition = { why: "Failed.", ${property} };
      defineDiagnostics({ docsBase: "https://example.com/diagnostics", codes: {
        EXAMPLE_FAILED: definition,
        EXAMPLE_OTHER: { why: "Other." },
      } });
    `)
    expect(found).toEqual([
      expect.objectContaining({ code: "EXAMPLE_FAILED", docsBase: "https://example.com/diagnostics", docs: "https://example.com/guide#failed" }),
      expect.objectContaining({ code: "EXAMPLE_OTHER", docsBase: "https://example.com/diagnostics", docs: null }),
    ])
  })
})

describe("diagnostic pages", () => {
  const pages = diagnosticPages({
    codes,
    sectionTitles: { queue: "Queue", blob: "Blob" },
    limits: { queue: "## Configuration errors\n\n### QUEUE_DISABLED\n\nThe Vite config sets `queue: false`. See [QUEUE_MISSING_REGION](#queue_missing_region) and [delivery](#local-delivery).\n\n### QUEUE_MISSING_REGION\n\nSet a region.\n" },
    guides: { QUEUE_MISSING_REGION: { frontmatter: "description: Set the region of a Vercel queue.\nseo.title: \"QUEUE_MISSING_REGION: set the Vercel queue region\"", body: "## Fix it\n\nSet `queue.region`.\n" } },
    repository: "https://github.com/vite-hub/vitehub",
  })

  it("writes an indexed Overview that opens a panel and lists every code with a link", () => {
    const overview = pages.get("docs/queue/diagnostics/index.md")!
    expect(overview).toContain("navigation.panel: true")
    expect(overview).not.toContain("seo.index")
    expect(overview).toContain("title: \"Queue diagnostics\"")
    expect(overview).toContain("Its `docs` link opens the page of that code.")
    for (const queueCode of codes.filter(candidate => candidate.pkg === "queue")) expect(overview).toContain(`(${diagnosticPath("queue", queueCode.code)})`)
  })

  it("keeps generated code pages out of search engines, with the code as the page heading", () => {
    const page = pages.get("docs/queue/diagnostics/queue_disabled.md")!
    expect(page).toMatch(/^---\ntitle: QUEUE_DISABLED\n/)
    expect(page).toContain("seo.index: false")
    expect(page).toContain("navigation.group: \"Configuration errors\"")
    expect(page).toContain("> Queue is disabled in this runtime.")
    // The Details come from the `limits-and-errors` page. A code anchor opens the code page, another anchor the old page.
    expect(page).toContain("[QUEUE_MISSING_REGION](/docs/queue/diagnostics/queue_missing_region)")
    expect(page).toContain("[delivery](/docs/queue/limits-and-errors#local-delivery)")
    expect(page).toContain("https://github.com/vite-hub/vitehub/blob/main/packages/queue/src/")
  })

  it("gives every generated index a unique description within the search audit limits", () => {
    const descriptions: string[] = []
    for (const [file, source] of pages) {
      if (!file.endsWith("/index.md") && file !== "docs/reference/diagnostics.md") continue
      const description: unknown = JSON.parse(source.match(/^description: (.+)$/m)![1]!)
      if (typeof description !== "string") throw new Error(`Missing description in ${file}`)
      expect(description.length, file).toBeGreaterThanOrEqual(docsSeoLimits.description.min)
      expect(description.length, file).toBeLessThanOrEqual(docsSeoLimits.description.max)
      descriptions.push(description)
    }
    expect(descriptions.length).toBeGreaterThan(1)
    expect(new Set(descriptions).size).toBe(descriptions.length)
  })

  it("indexes a code page with a guide and lets the guide replace generated fields", () => {
    const page = pages.get("docs/queue/diagnostics/queue_missing_region.md")!
    expect(page).not.toContain("seo.index: false")
    expect(page).toContain("description: Set the region of a Vercel queue.")
    expect(page.match(/^description:/gm)).toHaveLength(1)
    expect(page).toContain("## Fix it")
    expect(page).not.toContain("## How to fix it")
    expect(pages.get("docs/queue/diagnostics/index.md")).toContain("[`QUEUE_MISSING_REGION`](/docs/queue/diagnostics/queue_missing_region) (guide)")
  })

  it("lists every section on the All diagnostics page", () => {
    const all = pages.get("docs/reference/diagnostics.md")!
    expect(all).toContain("[Queue](/docs/queue/diagnostics)")
    expect(all).toContain(`ViteHub has ${codes.length} error codes.`)
  })

  it("stops on a guide for a code that no catalog defines", () => {
    expect(() => diagnosticPages({ codes, sectionTitles: {}, limits: {}, guides: { QUEUE_GONE: { frontmatter: "", body: "" } }, repository: "" })).toThrow("QUEUE_GONE")
  })
})

describe("diagnostic text", () => {
  it("groups numbered codes by family letter", () => {
    expect(diagnosticGroup({ code: "BLOB_C0001", group: null })).toBe("Configuration errors")
    expect(diagnosticGroup({ code: "BLOB_B0001", group: null })).toBe("Build errors")
    expect(diagnosticGroup({ code: "BLOB_R0001", group: null })).toBe("Runtime errors")
    expect(diagnosticGroup({ code: "QUEUE_DISABLED", group: "Config errors" })).toBe("Configuration errors")
  })

  it("escapes placeholders outside inline code only", () => {
    expect(markdownText("Set <name> in `server/queues/<name>.ts`.")).toBe("Set \\<name\\> in `server/queues/<name>.ts`.")
  })

  it("reads the `### CODE` sections of a limits page and skips code fences", () => {
    const sections = limitsSections("## Errors\n\n### KV_A\n\nA text.\n\n```md\n### KV_FAKE\n```\n\n### KV_B\n\nB text.\n\n## Limits\n\nNot B.\n")
    expect([...sections.keys()]).toEqual(["KV_A", "KV_B"])
    expect(sections.get("KV_A")).toContain("### KV_FAKE")
    expect(sections.get("KV_B")).toBe("B text.")
  })
})
