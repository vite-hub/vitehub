import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { build } from "vite"
import { afterAll, expect, it } from "vitest"

import { hubAgent } from "../src/vite.ts"

const dist = resolve(import.meta.dirname, "../dist")
const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { force: true, recursive: true })))
})

it("keeps the AI emulator out of a build with agent.models.emulate", async () => {
  // Inside the package, so the generated runtime capability imports resolve as they do in an application.
  const cache = resolve(import.meta.dirname, "../node_modules/.cache")
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "model-emulation-build-"))
  roots.push(root)
  const entry = join(root, "agent.js")
  await writeFile(entry, [
    `import { defineAgent, runAgent } from ${JSON.stringify(pathToFileURL(join(dist, "index.js")).href)}`,
    `const agent = defineAgent({ driver: { model: "openai/gpt-5.1" } })`,
    `export default agent`,
    `export const answer = () => runAgent(agent, { prompt: "hello" })`,
  ].join("\n"))
  const outDir = join(root, "dist")
  await build({
    configFile: false,
    logLevel: "silent",
    root,
    plugins: [hubAgent({ models: { emulate: { rules: [{ id: "hello", match: { textContains: "hello" }, reply: [{ type: "text", text: "Hi." }] }] } } })],
    ssr: { noExternal: true },
    build: {
      minify: false,
      outDir,
      ssr: entry,
      // Every bare package stays external, so an import of the emulator packages shows as an import statement.
      rolldownOptions: { external: id => !id.startsWith(".") && !isAbsolute(id) && !id.startsWith("file:") && !id.startsWith("\0") },
    },
  })
  const files = await readdir(outDir, { recursive: true })
  const output = (await Promise.all(files.filter(file => /\.m?js$/.test(file)).map(file => readFile(join(outDir, file), "utf8")))).join("\n")
  expect(output).toContain("defineAgent")
  // The runtime names the `emulate` gateway and the packages in its diagnostics, so match only module specifiers.
  expect(output).not.toMatch(/(?:from|import)\s*\(?\s*["'](?:emulate|@emulators\/[^"']+)["']/)
  expect(output).not.toContain("model-emulation-dev")
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
  expect(process.env.VITEHUB_EMULATE_URL).toBeUndefined()
}, 120_000)
