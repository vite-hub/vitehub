import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"

import { loadChannelTargets } from "../src/internal/channel-sync-cli.ts"

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(failImport: boolean) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-channel-stage-loader-"))
  roots.push(root)
  const events = join(root, "events.jsonl")
  await mkdir(join(root, "server/agents/support"), { recursive: true })
  await writeFile(join(root, "server/agents/support/agent.ts"), `
    import channel from "virtual:stage-channel"
    ${failImport ? 'throw new Error("Agent import failed")' : ""}
    export default { driver: { run: () => "" }, channels: { service: channel } }
  `)
  await writeFile(join(root, "vite.config.mjs"), String.raw`
    import { appendFileSync } from "node:fs"
    import { nitro } from ${JSON.stringify(import.meta.resolve("nitro/vite"))}
    const record = event => appendFileSync(${JSON.stringify(events)}, JSON.stringify(event) + "\n")
    let ready = false
    export default {
      plugins: [nitro(), {
        name: "stage-channel",
        nitro: { setup(instance) { instance.hooks.hook("close", () => record("nitro:closed")) } },
        configResolved(config) {
          // Fail if Channel discovery creates Nitro's unused worker environment.
          config.environments.nitro.dev.createEnvironment = () => { throw new Error("unused Nitro worker started") }
        },
        configureServer: {
          order: "post",
          handler(server) {
            record({ mode: server.config.mode, environments: Object.keys(server.environments).sort() })
            server.middlewares.use((_req, _res, next) => next())
            return () => { ready = true; record("server:configured") }
          },
        },
        resolveId(id) { if (id === "virtual:stage-channel") return "\0stage-channel" },
        load(id) {
          if (id !== "\0stage-channel") return
          if (!ready) throw new Error("configureServer did not initialize the Channel")
          return 'export default { kind: "test", history: {}, webhooks: false }'
        },
        closeBundle() { record("environment:closed") },
      }],
    }
  `)
  return { events, root }
}

it.each([false, true])("runs server hooks and closes stage resources after an Agent import (failure: %s)", async (failImport) => {
  const { events, root } = await fixture(failImport)
  const result = loadChannelTargets({ rootDir: root, stage: "production", env: { ...process.env } })
  if (failImport) await expect(result).rejects.toThrow("Agent import failed")
  else await expect(result).resolves.toMatchObject([{ agent: "support", channel: "service", provider: "test", history: true }])
  const recorded = (await readFile(events, "utf8")).trim().split("\n").map(line => JSON.parse(line) as unknown)
  expect(recorded).toContainEqual({ mode: "production", environments: ["client", "ssr"] })
  expect(recorded).toContain("server:configured")
  expect(recorded).toContain("environment:closed")
  expect(recorded).toContain("nitro:closed")
})
