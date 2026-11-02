import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { build } from "vite"
import { afterAll, describe, expect, it } from "vitest"

import { createProviderAgentAdapter, inspectAgentProvider } from "../src/runtime/provider-agent-worker.ts"
import { hubAgent } from "../src/vite.ts"

const dist = resolve(import.meta.dirname, "../dist")
const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { force: true, recursive: true })))
})

// Bundles one Agent against the published dist and returns the emitted server code.
async function bundleAgent(imports: string, driver: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-provider-bundle-"))
  roots.push(root)
  const entry = join(root, "agent.js")
  await writeFile(entry, [
    `import { ${imports} } from ${JSON.stringify(pathToFileURL(join(dist, "index.js")).href)}`,
    `export default defineAgent({ driver: ${driver} })`,
  ].join("\n"))
  const outDir = join(root, "dist")
  await build({
    configFile: false,
    logLevel: "silent",
    root,
    build: {
      minify: false,
      outDir,
      ssr: entry,
      // Package imports stay external, so a retained provider runtime import shows up as its specifier.
      rolldownOptions: { external: id => !id.startsWith(".") && !isAbsolute(id) && !id.startsWith("file:") && !id.startsWith("\0") },
    },
  })
  const files = await readdir(outDir, { recursive: true })
  const chunks = await Promise.all(files.filter(file => /\.m?js$/.test(file)).map(file => readFile(join(outDir, file), "utf8")))
  return chunks.join("\n")
}

function generateBundle(moduleIds: string[]) {
  const plugin = hubAgent()
  // SAFETY: hubAgent defines generateBundle as a callable Vite hook; it reads only the output chunks.
  return (plugin.generateBundle as (...args: unknown[]) => void).call({}, {}, {
    "index.mjs": { type: "chunk", moduleIds },
    "style.css": { type: "asset" },
  })
}

describe("provider Agent Drivers", () => {
  it("bundles the provider runtime only when the app calls a provider Driver factory", async () => {
    const run = await bundleAgent("defineAgent", "{ run: () => \"ok\" }")
    expect(run).not.toContain("#vitehub/agent/provider-agent")

    const codex = await bundleAgent("codexDriver, defineAgent", "codexDriver()")
    expect(codex).toContain("#vitehub/agent/provider-agent")
  }, 60_000)

  it("fails a Worker build whose output contains the provider runtime stub", () => {
    expect(() => generateBundle(["/app/server/agents/support.ts", "/app/node_modules/@vite-hub/agent/dist/runtime/provider-agent-worker.js"]))
      .toThrow(expect.objectContaining({ code: "AGENT_B0019" }))
    expect(() => generateBundle(["C:\\app\\node_modules\\@vite-hub\\agent\\src\\runtime\\provider-agent-worker.ts"]))
      .toThrow(/cannot run in a Cloudflare Worker/)
  })

  it("keeps builds without the provider runtime stub", () => {
    expect(() => generateBundle(["/app/server/agents/support.ts", "/app/node_modules/@vite-hub/agent/dist/provider-agent.js"])).not.toThrow()
  })

  it("fails provider Driver calls that reach the Worker runtime", async () => {
    // SAFETY: The Worker module throws before it reads any option.
    expect(() => createProviderAgentAdapter({} as never)).toThrow(expect.objectContaining({ code: "AGENT_R0928" }))
    // SAFETY: The Worker module throws before it reads any option or context.
    expect(() => inspectAgentProvider({} as never, {} as never)).toThrow(/require a Node\.js host/)
  })
})
