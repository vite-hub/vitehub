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
  it("collects source-local handles without file or export conventions", () => {
    const file = "/project/server/api/images.post.ts"
    const source = [
      'import { defineRateLimit as define } from "@vite-hub/rate-limit"',
      "",
      'const uploads = define("image-upload", { failure: "deny", limit: 5, window: "1m" })',
    ].join("\n")

    expect(extractRateLimitDeclarations(file, source)).toEqual([{
      name: "image-upload",
      policy: { enforcement: "best-effort", failure: "deny", limit: 5, window: "1m" },
      source: { column: 17, file, line: 3 },
    }])
  })

  it("collects handles through namespace imports", () => {
    const file = "/project/server/api/search.ts"
    const source = [
      'import * as rateLimit from "@vite-hub/rate-limit"',
      'const search = rateLimit.defineRateLimit("search", { limit: 5, window: "1m" })',
    ].join("\n")

    expect(extractRateLimitDeclarations(file, source)).toMatchObject([{ name: "search" }])
  })

  it("collects handles from JSX and TSX modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-jsx-"))
    roots.push(root)
    const declaration = 'import { defineRateLimit } from "vite-hub/rate-limit"\nconst limit = defineRateLimit("jsx", { limit: 1, window: "1m" })\n'
    await writeFile(join(root, "route.tsx"), declaration)

    expect(discoverRateLimitDeclarations({ rootDir: root })).toMatchObject([{ name: "jsx" }])
  })

  it("requires top-level static declarations", () => {
    const imported = 'import { defineRateLimit } from "@vite-hub/rate-limit"\n'
    expect(() => extractRateLimitDeclarations("nested.ts", `${imported}function create() { return defineRateLimit("uploads", { limit: 1, window: "1m" }) }`))
      .toThrow("top-level `const`")
    expect(() => extractRateLimitDeclarations("dynamic.ts", `${imported}const limit = 1\nconst uploads = defineRateLimit("uploads", { limit, window: "1m" })`))
      .toThrow('option "limit" must be a static literal')
    expect(() => extractRateLimitDeclarations("id.ts", `${imported}const id = "uploads"\nconst uploads = defineRateLimit(id, { limit: 1, window: "1m" })`))
      .toThrow("non-empty static string ID")
  })

  it("unwraps transparent TypeScript assertions in static policies", () => {
    const imported = 'import { defineRateLimit } from "@vite-hub/rate-limit"\nimport type { RateLimitPolicy } from "@vite-hub/rate-limit"\n'
    expect(extractRateLimitDeclarations("asserted.ts", `${imported}const uploads = defineRateLimit("uploads", { limit: 10 as const, window: "1m" } as const)`))
      .toMatchObject([{ name: "uploads", policy: { limit: 10, window: "1m" } }])
    expect(extractRateLimitDeclarations("satisfies.ts", `${imported}const uploads = defineRateLimit("uploads", { limit: 10, window: "1m" } satisfies RateLimitPolicy)`))
      .toMatchObject([{ name: "uploads", policy: { limit: 10, window: "1m" } }])
  })

  it("ignores local bindings that shadow the imported helper", () => {
    const source = [
      'import { defineRateLimit as define } from "@vite-hub/rate-limit"',
      'const uploads = define("uploads", { limit: 1, window: "1m" })',
      'function helper(define: (id: string, policy: object) => unknown) {',
      '  return define("local", { limit: 2, window: "1m" })',
      '}',
    ].join("\n")

    expect(extractRateLimitDeclarations("shadowed.ts", source)).toHaveLength(1)

    const declarations = [
      'import { defineRateLimit as define } from "@vite-hub/rate-limit"',
      'function helper() {',
      '  function define() {}',
      '  return define("local", { limit: 2, window: "1m" })',
      '}',
      'try {} catch (define) { define("local", { limit: 2, window: "1m" }) }',
    ].join("\n")
    expect(extractRateLimitDeclarations("declaration-shadow.ts", declarations)).toEqual([])

    const namedExpression = [
      'import { defineRateLimit as define } from "@vite-hub/rate-limit"',
      'const helper = function define() {',
      '  return define("local", { limit: 2, window: "1m" })',
      '}',
    ].join("\n")
    expect(extractRateLimitDeclarations("named-expression-shadow.ts", namedExpression)).toEqual([])

    const lexicalScopes = [
      'import { defineRateLimit } from "@vite-hub/rate-limit"',
      'for (const defineRateLimit of []) { defineRateLimit() }',
      'switch (true) { case true: { const defineRateLimit = () => {}; defineRateLimit(); break } }',
      'const helper = class defineRateLimit { method() { defineRateLimit() } }',
    ].join("\n")
    expect(extractRateLimitDeclarations("lexical-shadow.ts", lexicalScopes)).toEqual([])
  })

  it("reports duplicate IDs with both source locations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-declarations-"))
    roots.push(root)
    await mkdir(join(root, "server", "api"), { recursive: true })
    const declaration = 'import { defineRateLimit } from "vite-hub/rate-limit"\nconst limit = defineRateLimit("uploads", { limit: 1, window: "1m" })\n'
    await writeFile(join(root, "server", "api", "first.ts"), declaration)
    await writeFile(join(root, "server", "api", "second.ts"), declaration)

    expect(() => discoverRateLimitDeclarations({ rootDir: root }))
      .toThrow(/Duplicate Rate Limit ID "uploads"[\s\S]*first\.ts:2:15[\s\S]*second\.ts:2:15/)
  })

  it("does not provision handles declared only in tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-tests-"))
    roots.push(root)
    const declaration = 'import { defineRateLimit } from "vite-hub/rate-limit"\nconst limit = defineRateLimit("test-only", { limit: 1, window: "1m" })\n'
    await writeFile(join(root, "rate-limit.test.ts"), declaration)
    await mkdir(join(root, "test"))
    await writeFile(join(root, "test", "helper.ts"), declaration)
    await mkdir(join(root, "src", "__tests__"), { recursive: true })
    await writeFile(join(root, "src", "__tests__", "helper.ts"), declaration)
    await mkdir(join(root, "server", "tests"), { recursive: true })
    await writeFile(join(root, "server", "tests", "helper.ts"), declaration)

    expect(discoverRateLimitDeclarations({ rootDir: root })).toEqual([])
  })

  it("applies test exclusions relative to each configured scan root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-root-"))
    const scanRoot = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-scan-root-"))
    roots.push(root, scanRoot)
    const declaration = 'import { defineRateLimit } from "vite-hub/rate-limit"\nconst limit = defineRateLimit("test-only", { limit: 1, window: "1m" })\n'
    await mkdir(join(scanRoot, "test"))
    await writeFile(join(scanRoot, "test", "helper.ts"), declaration)

    expect(discoverRateLimitDeclarations({ rootDir: root, scanDirs: [scanRoot] })).toEqual([])
  })

  it("collects deployed routes beneath directories named test", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-test-route-"))
    roots.push(root)
    const routeDir = join(root, "server", "api", "test")
    await mkdir(routeDir, { recursive: true })
    await writeFile(join(routeDir, "upload.post.ts"), 'import { defineRateLimit } from "vite-hub/rate-limit"\nconst limit = defineRateLimit("upload", { limit: 1, window: "1m" })\n')

    expect(discoverRateLimitDeclarations({ rootDir: root })).toMatchObject([{ name: "upload" }])
  })

  it("collects deployable example and fixture directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-deployable-assets-"))
    roots.push(root)
    const declaration = 'import { defineRateLimit } from "vite-hub/rate-limit"\nconst limit = defineRateLimit("upload", { limit: 1, window: "1m" })\n'
    await mkdir(join(root, "src", "fixtures"), { recursive: true })
    await writeFile(join(root, "src", "fixtures", "upload.ts"), declaration)

    expect(discoverRateLimitDeclarations({ rootDir: root })).toMatchObject([{ name: "upload" }])
  })
})
