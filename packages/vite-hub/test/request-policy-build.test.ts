import { createBuilder } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { startBuiltServer } from "./content-preview-fixture.ts"
import { createProject } from "./support/content-cms.ts"

const echo = "import { defineHandler } from 'h3'\nexport default defineHandler(event => ({ url: event.url.href, req: event.req.url }))\n"

describe("trustProxy and sameOriginWrites in a built Node server", () => {
  it("serves https URLs behind a proxy and refuses cross-origin writes with cookies", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ name: "request-policy-build", private: true, type: "module" }),
      "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
      "server/plugins/async.ts": "export default async () => { await Promise.resolve() }\n",
      "server/routes/api/url.ts": echo,
      "server/routes/api/notes.post.ts": echo,
      "server/routes/hooks/inbox.post.ts": echo,
      // A middleware that a cross-origin write must never reach.
      "server/middleware/writes.ts": "import { defineHandler, HTTPError } from 'h3'\nexport default defineHandler((event) => {\n  if (event.req.headers.get('x-reached') === 'fail') throw new HTTPError({ status: 500 })\n})\n",
    })
    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    const app = [vitehub({ host: "node", trustProxy: true, sameOriginWrites: { exclude: ["/hooks"] } }), nitro()]
    const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: app, root, nitro: { plugins: [`${root}/server/plugins/async.ts`] } } as never)
    await builder.buildApp()

    const server = await startBuiltServer(root, {})
    const base = `127.0.0.1:${server.port}`
    try {
      const proxied = await (await server.fetch("/api/url", { headers: { "x-forwarded-proto": "https" } })).json()
      // The route and code that reads the Web request, such as Better Auth, both see https.
      expect(proxied).toEqual({ url: `https://${base}/api/url`, req: `https://${base}/api/url` })
      expect(await (await server.fetch("/api/url")).json()).toMatchObject({ url: `http://${base}/api/url` })

      const write = (path: string, headers: Record<string, string>) => server.fetch(path, { method: "POST", headers: { "x-reached": "fail", ...headers } })
      const foreign = await write("/api/notes", { cookie: "session=1", origin: "https://evil.test", "sec-fetch-site": "cross-site" })
      expect(foreign.status).toBe(403)
      expect(await foreign.json()).toMatchObject({ error: { code: "VITEHUB_CROSS_ORIGIN_WRITE" } })
      expect((await write("/api/notes", { cookie: "session=1", "sec-fetch-site": "same-site" })).status).toBe(403)
      expect((await write("/hooks/inbox", { cookie: "session=1", origin: "https://evil.test" })).status).toBe(500)

      const own = await server.fetch("/api/notes", { method: "POST", headers: { cookie: "session=1", origin: `https://${base}`, "x-forwarded-proto": "https", "sec-fetch-site": "same-origin" } })
      expect(own.status).toBe(200)
      expect(await own.json()).toMatchObject({ url: `https://${base}/api/notes` })
      expect((await server.fetch("/api/notes", { method: "POST", headers: { authorization: "Bearer t", origin: "https://evil.test" } })).status).toBe(200)
    }
    finally {
      server.close()
    }
  }, 120_000)
})
