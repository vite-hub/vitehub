import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { hubContent } from "@vite-hub/content/vite"
import { build, createNitro, prepare, prerender } from "nitro/builder"
import { expect, it } from "vitest"

import { createProject } from "./support/content-cms.ts"

it("registers KV in Nitro 3's separate prerender compilation", async () => {
  const sha = "a".repeat(40)
  const root = await createProject({
    "package.json": '{"type":"module"}',
    "kv.ts": `const values = new Map(); export const kv = { get: async key => [null, values.get(key)], set: async (key, value) => { values.set(key, value); return [null, null] } }`,
    // The Source stays offline; only the host's Content/KV registration is under test here.
    "server/content.ts": `
      import { defineContent } from '@vite-hub/content'
      export default defineContent({ logger: false, access: "public", sources: { docs: {
        name: 'github', authenticated: async () => true,
        resolveRevision: async () => ({ id: '${sha}', immutable: true, ref: 'main' }),
        getKeys: async () => [], getItem: async () => undefined,
      } } })
    `,
    "server/routes/head.ts": `import content from '../content'; export default () => content.sources.head('docs')`,
  })
  const content = hubContent()
  const configResolved = typeof content.configResolved === "function" ? content.configResolved : content.configResolved!.handler
  await Reflect.apply(configResolved, {}, [{ root, plugins: [{ name: "@vite-hub/kv/vite" }], resolve: { alias: [] } }])
  const host = await createNitro({
    rootDir: root,
    serverDir: join(root, "server"),
    preset: "node-server",
    builder: "rolldown",
    logLevel: 0,
    alias: { "@vite-hub/kv": join(root, "kv.ts") },
    modules: [content.nitro],
    prerender: { routes: ["/head"], failOnError: true },
  })
  try {
    await prepare(host)
    await build(host)
    await prerender(host)
    const result = JSON.parse(await readFile(join(root, ".output/public/head"), "utf8")) as unknown
    expect(result).toMatchObject({ live: true, sha })
  }
  finally {
    await host.close()
  }
}, 60_000)
