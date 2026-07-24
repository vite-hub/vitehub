import { readFile, readdir } from "node:fs/promises"

import { expect, it } from "vitest"

const moduleSpecifierPattern = /(?:\bfrom\s*|(?:\bimport|\brequire)\s*\(?\s*)["']([^"']+)["']/g

function moduleSpecifiers(source: string): string[] {
  return [...source.matchAll(moduleSpecifierPattern)].map(match => match[1]!)
}

function containsForbiddenPublicReference(source: string): boolean {
  return /\bFiberFailure\b/.test(source)
    || moduleSpecifiers(source).some(specifier => /^effect(?:\/|$)/.test(specifier))
}

async function readBundleGraph(entry: URL): Promise<string> {
  const sources: string[] = []
  const visited = new Set<string>()

  async function visit(file: URL): Promise<void> {
    if (visited.has(file.href)) return
    visited.add(file.href)
    const source = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (source === undefined) return
    sources.push(source)
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier.startsWith(".")) await visit(new URL(specifier, file))
    }
  }

  await visit(entry)
  return sources.join("\n")
}

it("keeps Effect out of published Agent declarations", async () => {
  const dist = new URL("../dist/", import.meta.url)
  const declarations = await Promise.all(
    (await readdir(dist, { recursive: true }))
      .filter(path => path.endsWith(".d.ts"))
      .map(path => readFile(new URL(path, dist), "utf8")),
  )

  const output = declarations.join("\n")
  expect(containsForbiddenPublicReference(output)).toBe(false)
  expect(output).not.toContain("class AgentOutputValidationError")
  expect(output).not.toContain("class TranscriptionError")
})

it("does not publish Agent-specific error constructors", async () => {
  const agent = await import("../dist/index.js")
  const capabilities = await import("../dist/capabilities.js")
  expect(agent).not.toHaveProperty("AgentOutputValidationError")
  expect(capabilities).not.toHaveProperty("TranscriptionError")
})

it("pins Effect to the Agent implementation dependency without leaking runtime failures", async () => {
  const dist = new URL("../dist/", import.meta.url)
  const javascript = (await Promise.all(
    (await readdir(dist, { recursive: true }))
      .filter(path => /\.[cm]?js$/.test(path))
      .map(path => readFile(new URL(path, dist), "utf8")),
  )).join("\n")
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown> | undefined>

  expect(javascript).not.toContain("FiberFailure")
  expect(manifest.dependencies?.effect).toBe("catalog:effect")
  expect(manifest.devDependencies?.effect).toBeUndefined()
  expect(manifest.optionalDependencies?.effect).toBeUndefined()
  expect(manifest.peerDependencies?.effect).toBeUndefined()
  expect(JSON.stringify(manifest.exports)).not.toContain("effect")
})

it("publishes additive Agent Invocation Stream error metadata", async () => {
  const dist = new URL("../dist/", import.meta.url)
  const declaration = (await Promise.all(
    (await readdir(dist, { recursive: true }))
      .filter(path => path.endsWith(".d.ts"))
      .map(path => readFile(new URL(path, dist), "utf8")),
  )).join("\n")

  expect(declaration).toMatch(/interface AgentInvocationStreamErrorEvent/)
  expect(declaration).toMatch(/code\?:/)
  expect(declaration).toMatch(/details\?: AgentPublicErrorDetails/)
  expect(declaration).toMatch(/requestId\?: string/)
})

it("keeps Effect out of provider and browser bundle graphs", async () => {
  for (const entry of ["cloudflare.js", "cloudflare/state.js", "messages.js", "output.js"]) {
    const bundle = await readBundleGraph(new URL(`../dist/${entry}`, import.meta.url))
    expect(containsForbiddenPublicReference(bundle), `${entry} must remain Effect and FiberFailure-free`).toBe(false)
  }
})

it("loads the optional Claude Code peer only after the built-in driver is selected", async () => {
  const bundle = await readBundleGraph(new URL("../dist/index.js", import.meta.url))

  expect(moduleSpecifiers(bundle)).not.toContain("@ai-sdk/harness-claude-code")
  expect(bundle).toContain(`const claudeCodePackage = "@ai-sdk/harness-claude-code"`)
})

it.each([
  'import { Effect } from "effect"',
  'export type { Effect } from "effect/Effect"',
  'import "effect/Schema"',
  'const effect = import("effect")',
  'const effect = require("effect")',
  'import Effect = require("effect")',
  "export type PublicFailure = FiberFailure",
])("detects a forbidden public reference in %s", source => {
  expect(containsForbiddenPublicReference(source)).toBe(true)
})
