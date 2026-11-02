import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { build } from "vite"
import { afterAll, expect, it } from "vitest"

const dist = resolve(import.meta.dirname, "../dist")
const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { force: true, recursive: true })))
})

// Bundles one Agent against the published dist and returns the emitted server code.
async function bundleAgent(imports: string, channels: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-channel-bundle-"))
  roots.push(root)
  const entry = join(root, "agent.js")
  await writeFile(entry, [
    `import { defineAgent } from ${JSON.stringify(pathToFileURL(join(dist, "index.js")).href)}`,
    `import { ${imports} } from ${JSON.stringify(pathToFileURL(join(dist, "channels.js")).href)}`,
    `export default defineAgent({ channels: ${channels}, driver: { run: () => "ok" } })`,
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
      // Packages stay external, so a retained adapter import shows up as its specifier.
      rolldownOptions: { external: id => !id.startsWith(".") && !isAbsolute(id) && !id.startsWith("file:") && !id.startsWith("\0") },
    },
  })
  const files = await readdir(outDir, { recursive: true })
  const chunks = await Promise.all(files.filter(file => /\.m?js$/.test(file)).map(file => readFile(join(outDir, file), "utf8")))
  return chunks.join("\n")
}

it("bundles only the chat adapters of the Channels that an Agent imports", async () => {
  const webOnly = await bundleAgent("webChat", "{ web: webChat() }")
  expect(webOnly).not.toContain("@chat-adapter/discord")
  expect(webOnly).not.toContain("@chat-adapter/teams")

  const withDiscord = await bundleAgent("discord, webChat", "{ web: webChat(), discord: discord({ adapter: true }) }")
  expect(withDiscord).toContain("@chat-adapter/discord")
  expect(withDiscord).not.toContain("@chat-adapter/teams")
}, 60_000)
