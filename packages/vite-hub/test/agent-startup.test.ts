import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { Miniflare } from "miniflare"
import { createBuilder } from "vite"
import { expect, it } from "vitest"

import { vitehub } from "vite-hub"

/** The source of every output file that `file` imports statically, as a Worker loads them at startup. */
async function startupSources(file: string, seen = new Map<string, string>()): Promise<Map<string, string>> {
  if (seen.has(file)) return seen
  const source = await readFile(file, "utf8")
  seen.set(file, source)
  const imports = [...source.matchAll(/^(?:import|export)\b[^;"']*?["'](\.{1,2}\/[^"']+)["']/gm)].map(match => match[1]!)
  for (const path of imports) await startupSources(resolve(dirname(file), path), seen)
  return seen
}

/** The modules that Rolldown wrote into `sources`, from its `//#region <module>` comments. */
function bundledModules(sources: Iterable<string>): string[] {
  return [...sources].flatMap(source => [...source.matchAll(/^\/\/#region (.+)$/gm)].map(match => match[1]!))
}

it("loads the Agent routes and Agent Definitions on the first request, not at Worker startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-startup-"))
  let worker: Miniflare | undefined
  try {
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await mkdir(join(root, "server/agents"), { recursive: true })
    await writeFile(join(root, "server/agents/hello.ts"), [
      "import { defineAgent } from \"vite-hub/agent\"",
      "import { webChat } from \"vite-hub/agent/channels\"",
      "",
      "export default defineAgent({",
      "  channels: { web: webChat() },",
      "  driver: {",
      "    async *run() {",
      "      yield { type: \"text-delta\" as const, text: \"Hello from the Agent\" }",
      "      yield { type: \"finish\" as const }",
      "    },",
      "  },",
      "})",
      "",
    ].join("\n"))

    const builder = await createBuilder({ logLevel: "silent", plugins: [vitehub({ preset: "cloudflare", agent: true })], root })
    await builder.buildApp()

    const server = join(root, ".output/server")
    const files = (await readdir(server, { recursive: true })).filter(file => file.endsWith(".mjs"))
    const output = bundledModules(await Promise.all(files.map(file => readFile(join(server, file), "utf8"))))
    const definition = /\/server\/agents\/hello\.ts$/
    const routes = /\/\.vitehub\/agent\/chat-webhook-route\.ts$/
    expect(output).toContainEqual(expect.stringMatching(definition))
    expect(output).toContainEqual(expect.stringMatching(routes))

    const startup = bundledModules((await startupSources(join(server, "index.mjs"))).values())
    expect(startup).toContainEqual(expect.stringMatching(/agent\/dist\/cloudflare\/state\.js$/))
    expect(startup.filter(module => definition.test(module) || routes.test(module))).toEqual([])
    // The Agent routes import the Workspace runtime. Nothing else at startup does.
    expect(output).toContainEqual(expect.stringMatching(/workspace\/dist\//))
    expect(startup.filter(module => /workspace\/dist\//.test(module))).toEqual([])

    const wrangler = JSON.parse(await readFile(join(server, "wrangler.json"), "utf8")) as {
      compatibility_flags?: string[]
      durable_objects: { bindings: Array<{ class_name: string, name: string }> }
    }
    // Wrangler uploads every file that its `rules` match, so the Worker can import the lazy chunks.
    worker = new Miniflare({
      // The build writes today's date. The pinned workerd binary can be older.
      compatibilityDate: "2026-04-20",
      compatibilityFlags: [...new Set([...wrangler.compatibility_flags ?? [], "nodejs_compat"])],
      durableObjects: Object.fromEntries(wrangler.durable_objects.bindings.map(binding => [binding.name, binding.class_name])),
      modules: ["index.mjs", ...files.filter(file => file !== "index.mjs")].map(file => ({ path: join(server, file), type: "ESModule" as const })),
      modulesRoot: server,
    })
    const response = await worker.dispatchFetch("http://localhost/api/_vitehub/agents/hello/chat", {
      body: JSON.stringify({ id: "startup", messages: [{ id: "user-1", parts: [{ text: "ping", type: "text" }], role: "user" }] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Hello from the Agent")
  }
  finally {
    await worker?.dispose()
    await rm(root, { force: true, recursive: true, maxRetries: 3 })
  }
}, 300_000)
