import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { build, type Plugin } from "vite"
import { afterAll, expect, it } from "vitest"

import type { AgentOptions } from "../src/types.ts"
import { hubAgent } from "../src/vite.ts"

const dist = resolve(import.meta.dirname, "../dist")
const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { force: true, recursive: true })))
})

const chatgptAgent = [
  `import { defineAgent } from ${JSON.stringify(pathToFileURL(join(dist, "index.js")).href)}`,
  `import { chatgpt } from "@vite-hub/gateways"`,
  `export default defineAgent({ driver: { model: "gpt-6.1-sol", gateway: chatgpt() } })`,
]

// Bundles one server entry with the Agent plugin and returns the emitted server code.
async function bundle(source: string[], plugins: Plugin[] = [], agentOptions?: AgentOptions): Promise<string> {
  // Inside the package, so the generated runtime capability imports resolve as they do in an application.
  const cache = resolve(import.meta.dirname, "../node_modules/.cache")
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "chatgpt-model-bundle-"))
  roots.push(root)
  const entry = join(root, "agent.js")
  await writeFile(entry, source.join("\n"))
  const outDir = join(root, "dist")
  await build({
    configFile: false,
    logLevel: "silent",
    root,
    plugins: [hubAgent(agentOptions), ...plugins],
    ssr: { noExternal: true },
    build: {
      minify: false,
      outDir,
      ssr: entry,
      // Other packages stay external. @ai-sdk/openai goes through the Agent plugin, then into the output.
      rolldownOptions: { external: id => id !== "@ai-sdk/openai" && !id.startsWith(".") && !isAbsolute(id) && !id.startsWith("file:") && !id.startsWith("\0") },
    },
  })
  const files = await readdir(outDir, { recursive: true })
  const chunks = await Promise.all(files.filter(file => /\.m?js$/.test(file)).map(file => readFile(join(outDir, file), "utf8")))
  return chunks.join("\n")
}

it("bundles @ai-sdk/openai for the ChatGPT model only when the application enables Connections", async () => {
  // The ChatGPT model reads its plan credential through Connections. Without them it stops with AGENT_R1016
  // before it loads @ai-sdk/openai, so the package only adds Worker size and startup work.
  const withoutConnections = await bundle(chatgptAgent)
  expect(withoutConnections).not.toContain("ai-sdk-openai/")
  expect(withoutConnections).toContain("The ChatGPT model needs Connections")

  const withConnections = await bundle(chatgptAgent, [{ name: "@vite-hub/connections/vite" }])
  expect(withConnections).toContain("ai-sdk-openai/")

  // vitehub() without Connections gives Agents `connections: false`.
  const disabledConnections = await bundle(chatgptAgent, [], { runtimeCapabilityImports: { connections: false } } as AgentOptions)
  expect(disabledConnections).not.toContain("ai-sdk-openai/")
}, 120_000)

it("keeps @ai-sdk/openai for AI gateway models without Connections", async () => {
  const gatewayModel = await bundle([
    `import { openai } from ${JSON.stringify(import.meta.resolve("@vite-hub/gateways"))}`,
    `import { languageModel } from ${JSON.stringify(import.meta.resolve("@vite-hub/gateways/ai-sdk"))}`,
    `export const model = () => languageModel(openai({ apiKey: "key" }), "gpt-5", { api: "responses" })`,
  ])
  expect(gatewayModel).toContain("ai-sdk-openai/")
}, 120_000)
