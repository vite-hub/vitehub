import { readFile, readdir } from "node:fs/promises"

import { expect, it } from "vitest"

const effectImportPattern = /(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']effect(?:\/[^"']*)?["']/

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
    for (const match of source.matchAll(/(?:from\s*|import\()\s*["']([^"']+)["']/g)) {
      const specifier = match[1]
      if (specifier?.startsWith(".")) await visit(new URL(specifier, file))
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
  expect(output).not.toMatch(effectImportPattern)
  expect(output).not.toContain("FiberFailure")
  expect(output).toContain("class AgentOutputValidationError extends ViteHubError")
  expect(output).toContain("class TranscriptionError extends ViteHubError")
})

it("keeps built Agent error constructors safe for hostile options", async () => {
  const { AgentOutputValidationError } = await import("../dist/index.js")
  const { TranscriptionError } = await import("../dist/capabilities.js")
  const secret = "https://user:token@example.com/private"
  const options = new Proxy({}, {
    get() {
      throw new Error(secret)
    },
  })

  const transcription = new TranscriptionError("TRANSCRIPTION_PROVIDER_FAILED", options)
  const output = new AgentOutputValidationError("AGENT_OUTPUT_INVALID_JSON", options)
  expect(JSON.stringify(transcription)).not.toContain(secret)
  expect(JSON.stringify(output)).not.toContain(secret)
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
    expect(bundle, `${entry} must remain Effect-free`).not.toMatch(effectImportPattern)
  }
})
