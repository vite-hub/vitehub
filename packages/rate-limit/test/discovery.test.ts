import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { discoverRateLimitDeclarations, extractRateLimitDeclarations } from "../src/discovery.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("Rate Limit declarations", () => {
  it("collects event-first guards inside handlers", () => {
    const file = "/project/server/api/images.post.ts"
    const source = [
      'import { requireRateLimit as requireLimit } from "@vite-hub/rate-limit"',
      "export default defineEventHandler(async (event) => {",
      "  await requireLimit(event, \"image-upload\", { failure: \"deny\", key: event.context.user.id, limit: 5, window: \"1m\" })",
      "})",
    ].join("\n")

    expect(extractRateLimitDeclarations(file, source)).toEqual([{
      name: "image-upload",
      policy: { enforcement: "best-effort", failure: "deny", limit: 5, window: "1m" },
      source: { column: 9, file, line: 3 },
    }])
  })

  it("collects framework auto-imported guards", () => {
    const source = [
      "export default defineEventHandler(async (event) => {",
      '  await requireRateLimit(event, "code-image", { failure: "deny", limit: 5, window: "1m" })',
      "})",
    ].join("\n")

    expect(extractRateLimitDeclarations("/project/server/api/code.post.ts", source)).toMatchObject([{
      name: "code-image",
      policy: { failure: "deny", limit: 5, window: "1m" },
    }])
  })

  it("collects guards through namespace imports", () => {
    const source = [
      'import * as rateLimit from "vite-hub/rate-limit"',
      "async function search(event) {",
      '  await rateLimit.requireRateLimit(event, "search", { limit: 5, window: "1m" })',
      "}",
    ].join("\n")

    expect(extractRateLimitDeclarations("/project/search.ts", source)).toMatchObject([{ name: "search" }])
  })

  it("collects guards through scoped dynamic imports", () => {
    const source = [
      "export async function upload(event) {",
      '  const { requireRateLimit: requireUploadLimit } = await import("vite-hub/rate-limit")',
      '  await requireUploadLimit(event, "image-upload", { failure: "deny", limit: 5, window: "1m" })',
      "}",
      "export async function search(event) {",
      '  const rateLimit = await import("@vite-hub/rate-limit")',
      '  await rateLimit.requireRateLimit(event, "search", { limit: 10, window: "10s" })',
      "}",
      "export async function canonicalNamespace(event) {",
      '  const requireRateLimit = await import("vite-hub/rate-limit")',
      '  await requireRateLimit.requireRateLimit(event, "canonical-namespace", { limit: 3, window: "1m" })',
      '  await requireRateLimit(event, "not-a-guard", { limit: 1, window: "1m" })',
      "}",
    ].join("\n")

    expect(extractRateLimitDeclarations("/project/limits.ts", source)).toMatchObject([
      { name: "image-upload", policy: { failure: "deny", limit: 5, window: "1m" } },
      { name: "search", policy: { limit: 10, window: "10s" } },
      { name: "canonical-namespace", policy: { limit: 3, window: "1m" } },
    ])
  })

  it("collects dynamic guards from closures declared before the import", () => {
    const source = [
      "export async function upload(event) {",
      "  async function guard() {",
      '    await requireRateLimit(event, "image-upload", { limit: 5, window: "1m" })',
      "  }",
      '  const { requireRateLimit } = await import("vite-hub/rate-limit")',
      "  await guard()",
      "}",
    ].join("\n")

    expect(extractRateLimitDeclarations("/project/limits.ts", source)).toMatchObject([
      { name: "image-upload", policy: { limit: 5, window: "1m" } },
    ])
  })

  it("ignores unrelated dynamic imports and shadowed dynamic bindings", () => {
    const source = [
      "export async function upload(event) {",
      '  const { requireRateLimit } = await import("other-package")',
      '  await requireRateLimit(event, "unrelated", { limit: 1, window: "1m" })',
      "}",
      "export async function search(event) {",
      '  const { requireRateLimit } = await import("vite-hub/rate-limit")',
      "  function local(requireRateLimit) {",
      '    return requireRateLimit(event, "shadowed", { limit: 1, window: "1m" })',
      "  }",
      '  await requireRateLimit(event, "search", { limit: 2, window: "10s" })',
      "  return local",
      "}",
    ].join("\n")

    expect(extractRateLimitDeclarations("/project/limits.ts", source)).toMatchObject([{ name: "search" }])
  })

  it("collects guards from JSX and TSX modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-jsx-"))
    roots.push(root)
    await writeFile(join(root, "route.tsx"), [
      'import { requireRateLimit } from "vite-hub/rate-limit"',
      'export async function route(event) { await requireRateLimit(event, "jsx", { limit: 1, window: "1m" }) }',
      "",
    ].join("\n"))

    expect(discoverRateLimitDeclarations({ rootDir: root })).toMatchObject([{ name: "jsx" }])
  })

  it("requires static IDs and provider policy fields", () => {
    const imported = 'import { requireRateLimit } from "@vite-hub/rate-limit"\n'
    expect(() => extractRateLimitDeclarations("args.ts", `${imported}requireRateLimit(event, "uploads")`))
      .toThrow("requires an event, a stable ID, and a static options object")
    expect(() => extractRateLimitDeclarations("dynamic.ts", `${imported}const limit = 1\nrequireRateLimit(event, "uploads", { limit, window: "1m" })`))
      .toThrow('option "limit" must be a static literal')
    expect(() => extractRateLimitDeclarations("id.ts", `${imported}const id = "uploads"\nrequireRateLimit(event, id, { limit: 1, window: "1m" })`))
      .toThrow("non-empty static string ID")
    expect(() => extractRateLimitDeclarations("spread.ts", `${imported}requireRateLimit(event, "uploads", { ...policy, key })`))
      .toThrow("cannot use object spreads")
    expect(() => extractRateLimitDeclarations("unknown.ts", `${imported}requireRateLimit(event, "uploads", { limit: 1, route: "/", window: "1m" })`))
      .toThrow('does not support the "route" option')
  })

  it("unwraps transparent TypeScript assertions", () => {
    const imported = 'import { requireRateLimit } from "@vite-hub/rate-limit"\nimport type { RequireRateLimitOptions } from "@vite-hub/rate-limit"\n'
    expect(extractRateLimitDeclarations("asserted.ts", `${imported}requireRateLimit(event, "uploads", { limit: 10 as const, window: "1m" } as const)`))
      .toMatchObject([{ name: "uploads", policy: { limit: 10, window: "1m" } }])
    expect(extractRateLimitDeclarations("satisfies.ts", `${imported}requireRateLimit(event, "uploads", { limit: 10, window: "1m" } satisfies RequireRateLimitOptions)`))
      .toMatchObject([{ name: "uploads", policy: { limit: 10, window: "1m" } }])
    expect(extractRateLimitDeclarations("id.ts", `${imported}requireRateLimit(event, "uploads" as const, { limit: 10, window: \`1m\` })`))
      .toMatchObject([{ name: "uploads", policy: { limit: 10, window: "1m" } }])
  })

  it("ignores local bindings that shadow the imported guard", () => {
    const source = [
      'import { requireRateLimit as requireLimit } from "@vite-hub/rate-limit"',
      'requireLimit(event, "uploads", { limit: 1, window: "1m" })',
      "function helper(requireLimit) {",
      '  return requireLimit(event, "local", { limit: 2, window: "1m" })',
      "}",
    ].join("\n")

    expect(extractRateLimitDeclarations("shadowed.ts", source)).toHaveLength(1)

    const declarations = [
      'import { requireRateLimit as requireLimit } from "@vite-hub/rate-limit"',
      "function helper() {",
      "  function requireLimit() {}",
      '  return requireLimit(event, "local", { limit: 2, window: "1m" })',
      "}",
      'try {} catch (requireLimit) { requireLimit(event, "local", { limit: 2, window: "1m" }) }',
    ].join("\n")
    expect(extractRateLimitDeclarations("declaration-shadow.ts", declarations)).toEqual([])
  })

  it("ignores top-level bindings that own the auto-import name", () => {
    const sources = [
      [
        'import { requireRateLimit } from "other-package"',
        'requireRateLimit(event, "unrelated-import", { limit: 1, window: "1m" })',
      ],
      [
        "export function requireRateLimit() {}",
        'requireRateLimit(event, "exported-function", { limit: 1, window: "1m" })',
      ],
      [
        "export default class requireRateLimit {}",
        'requireRateLimit(event, "exported-class", { limit: 1, window: "1m" })',
      ],
      [
        "const requireRateLimit = local",
        'requireRateLimit(event, "local-variable", { limit: 1, window: "1m" })',
      ],
      [
        "enum requireRateLimit { Local }",
        'requireRateLimit(event, "local-enum", { limit: 1, window: "1m" })',
      ],
      [
        "namespace requireRateLimit { export const local = true }",
        'requireRateLimit(event, "local-namespace", { limit: 1, window: "1m" })',
      ],
      [
        'import requireRateLimit = require("other-package")',
        'requireRateLimit(event, "import-equals", { limit: 1, window: "1m" })',
      ],
    ]

    for (const [index, source] of sources.entries()) {
      expect(extractRateLimitDeclarations(`top-level-shadow-${index}.ts`, source.join("\n"))).toEqual([])
    }
  })

  it("ignores parameter and block bindings that shadow an auto-import", () => {
    const source = [
      "async function parameter(event, requireRateLimit) {",
      '  await requireRateLimit(event, "parameter", { limit: 1, window: "1m" })',
      "}",
      "async function route(event) {",
      '  await requireRateLimit(event, "before-block", { limit: 2, window: "1m" })',
      "  {",
      "    const requireRateLimit = local",
      '    await requireRateLimit(event, "block", { limit: 1, window: "1m" })',
      "  }",
      '  await requireRateLimit(event, "after-block", { limit: 3, window: "1m" })',
      "}",
    ].join("\n")

    expect(extractRateLimitDeclarations("nested-shadow.ts", source)).toMatchObject([
      { name: "before-block" },
      { name: "after-block" },
    ])
  })

  it("respects var hoisting across nested statements", () => {
    const functionSource = [
      'requireRateLimit(event, "module", { limit: 1, window: "1m" })',
      "async function route(event) {",
      '  await requireRateLimit(event, "before-var", { limit: 1, window: "1m" })',
      "  if (enabled) { var requireRateLimit = local }",
      '  await requireRateLimit(event, "after-var", { limit: 1, window: "1m" })',
      "}",
    ].join("\n")
    expect(extractRateLimitDeclarations("function-var.ts", functionSource)).toMatchObject([{ name: "module" }])

    const programSource = [
      "if (enabled) { var requireRateLimit = local }",
      'requireRateLimit(event, "program-var", { limit: 1, window: "1m" })',
    ].join("\n")
    expect(extractRateLimitDeclarations("program-var.ts", programSource)).toEqual([])
  })

  it("deduplicates identical IDs and policies", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-declarations-"))
    roots.push(root)
    await mkdir(join(root, "server", "api"), { recursive: true })
    const declaration = 'import { requireRateLimit } from "vite-hub/rate-limit"\nrequireRateLimit(event, "uploads", { limit: 1, window: "1m" })\n'
    await writeFile(join(root, "server", "api", "first.ts"), declaration)
    await writeFile(join(root, "server", "api", "second.ts"), declaration)

    expect(discoverRateLimitDeclarations({ rootDir: root })).toHaveLength(1)
  })

  it("reports conflicting policies with both source locations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-conflicts-"))
    roots.push(root)
    await mkdir(join(root, "server", "api"), { recursive: true })
    const declaration = (limit: number) => `import { requireRateLimit } from "vite-hub/rate-limit"\nrequireRateLimit(event, "uploads", { limit: ${limit}, window: "1m" })\n`
    await writeFile(join(root, "server", "api", "first.ts"), declaration(1))
    await writeFile(join(root, "server", "api", "second.ts"), declaration(2))

    expect(() => discoverRateLimitDeclarations({ rootDir: root }))
      .toThrow(/Conflicting Rate Limit policies for ID "uploads"[\s\S]*first\.ts:2:1[\s\S]*second\.ts:2:1/)
  })

  it("excludes tests without excluding deployed routes named test", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-tests-"))
    roots.push(root)
    const declaration = 'import { requireRateLimit } from "vite-hub/rate-limit"\nrequireRateLimit(event, "upload", { limit: 1, window: "1m" })\n'
    await writeFile(join(root, "rate-limit.test.ts"), declaration)
    await mkdir(join(root, "server", "api", "test"), { recursive: true })
    await writeFile(join(root, "server", "api", "test", "upload.post.ts"), declaration)

    expect(discoverRateLimitDeclarations({ rootDir: root })).toMatchObject([{ name: "upload" }])
  })
})
