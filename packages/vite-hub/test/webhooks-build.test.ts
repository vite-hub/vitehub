import { createServer } from "node:http"
import { readdir, readFile } from "node:fs/promises"
import { delimiter, join } from "node:path"

import { createBuilder } from "vite"
import { describe, expect, it, onTestFinished, vi } from "vitest"

import { verifyWebhook } from "@vite-hub/env"

import { vitehub } from "../src/index.ts"
import { freePort, startBuiltServer } from "./content-preview-fixture.ts"
import { consoleTestKey } from "./support/console-signature.ts"
import { createProject, path, runCli } from "./support/content-cms.ts"

import type { IncomingHttpHeaders } from "node:http"
import type { ViteHubOptions } from "../src/index.ts"

const files = {
  "index.html": "<!doctype html><title>Webhooks</title>\n",
  "package.json": JSON.stringify({ name: "webhooks-build", private: true, type: "module" }),
  "server/webhooks/t3.ts": [
    "import { defineWebhook } from 'vite-hub/webhooks'",
    "",
    "export default defineWebhook({ url: 'T3_WEBHOOK_URL', secret: 'T3_WEBHOOK_SECRET', debounce: '1s' })",
    "",
  ].join("\n"),
  "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
  "server/routes/comment.post.ts": [
    "import { sendWebhook } from 'vite-hub/webhooks'",
    "",
    "export default {",
    "  async fetch(request: Request) {",
    "    const [error, sent] = await sendWebhook('t3', await request.json(), { event: 'comments.comment' })",
    "    return error ? Response.json({ code: error.code }, { status: 500 }) : Response.json(sent)",
    "  },",
    "}",
    "",
  ].join("\n"),
  "server/routes/deliveries.get.ts": [
    "import { listWebhookDeliveries } from 'vite-hub/webhooks/runtime'",
    "",
    "export default { fetch: async () => Response.json((await listWebhookDeliveries())[1]) }",
    "",
  ].join("\n"),
}

async function build(root: string, options: ViteHubOptions, plugins: unknown[] = []): Promise<void> {
  const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
  const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: [vitehub(options), nitro() as never, ...plugins], root } as never)
  await builder.buildApp()
}

// Stands for an owner package, such as Comments with `send: true`, that turns on member endpoints.
const sendPlugin = { name: "fixture-send", vitehub: { webhooks: { memberEndpoints: true, reason: "Sends waiting comments to each member's agent." } } }

// 203.0.113.10 is a public address in TEST-NET-3, so the guard takes it without DNS. The route sends its requests
// to the local receiver, because a test cannot get a certificate for it.
const memberFiles = {
  "index.html": "<!doctype html><title>Member endpoints</title>\n",
  "package.json": JSON.stringify({ name: "webhooks-members", private: true, type: "module" }),
  "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
  "server/routes/connect.post.ts": [
    "import { createMemberEndpoint } from 'vite-hub/webhooks'",
    "",
    "export default {",
    "  async fetch(request: Request) {",
    "    const { owner, url, secret } = await request.json()",
    "    const [error, endpoint] = await createMemberEndpoint({ owner, ownerName: 'Ana Ruiz', ownerEmail: 'ana@example.com', name: 'Launch plan thread', agent: 't3', kind: 'url', url, secret, hosts: ['203.0.113.10'] })",
    "    return error ? Response.json({ code: error.code, message: error.message }, { status: 400 }) : Response.json(endpoint)",
    "  },",
    "}",
    "",
  ].join("\n"),
  "server/routes/send.post.ts": [
    "import { sendToMemberEndpoint } from 'vite-hub/webhooks'",
    "",
    "const realFetch = globalThis.fetch",
    "globalThis.fetch = (input, init) => {",
    "  const url = new URL(String(input))",
    "  return url.hostname === '203.0.113.10' ? realFetch(`${process.env.RECEIVER_ORIGIN}${url.pathname}${url.search}`, init) : realFetch(input, init)",
    "}",
    "",
    "export default {",
    "  async fetch(request: Request) {",
    "    const { owner, body, key } = await request.json()",
    "    const [error, sent] = await sendToMemberEndpoint(owner, body, { event: 'comments.send', key })",
    "    return error ? Response.json({ code: error.code }, { status: 500 }) : Response.json(sent)",
    "  },",
    "}",
    "",
  ].join("\n"),
}

const queueHex = Buffer.from("vitehub-webhooks").toString("hex")

// Own file: it chdirs into the fixture, because the default libSQL file and the local Queue are relative to the working directory.
describe("Webhooks in a built Nitro 3 app", () => {
  it("fails the build when Queue is off", async () => {
    const root = await createProject(files)
    await expect(build(root, { database: true, host: "node", queue: false })).rejects.toMatchObject({ code: "WEBHOOKS_QUEUE_OFF", message: expect.stringContaining("server/webhooks/t3.ts") })
  }, 240_000)

  it("delivers to member endpoints in an app with no Queue and no server/webhooks/ files", async () => {
    const received: Array<{ headers: IncomingHttpHeaders, body: string, url: string }> = []
    const receiver = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", chunk => chunks.push(chunk))
      request.on("end", () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8"), url: request.url ?? "" })
        response.statusCode = 202
        response.end("ok")
      })
    })
    await new Promise<void>(done => receiver.listen(0, "127.0.0.1", done))
    const address = receiver.address()
    if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")

    const root = await createProject(memberFiles)
    process.chdir(root)
    process.env.PATH = `${join(import.meta.dirname, "../node_modules/.bin")}${delimiter}${path}`
    const port = await freePort()
    // `console: true` takes signed operation calls, such as `vitehub webhooks endpoints --url` with a CI key.
    const options: ViteHubOptions = { console: true, database: true, host: "node", publicUrl: `http://127.0.0.1:${port}` }
    const ci = await consoleTestKey("CI")
    const generate = await runCli(root, [vitehub(options), sendPlugin], ["database", "generate"])
    expect(generate.stderr).toBe("")
    expect(generate.exitCode).toBe(0)
    const migrations = join(root, "server/databases/default/migrations")
    const migration = (await readdir(migrations)).find(file => /^\d{14}_/.test(file))!
    const sql = await readFile(join(migrations, migration, "migration.sql"), "utf8")
    expect(sql).toContain("CREATE TABLE `vitehub_webhook_deliveries`")
    expect(sql).toContain("CREATE TABLE `vitehub_webhook_endpoints`")
    expect((await runCli(root, [vitehub(options), sendPlugin], ["database", "migrate"])).exitCode).toBe(0)

    await build(root, options, [sendPlugin])
    const registry = await readFile(join(root, ".vitehub/nitro/webhooks/registry.mjs"), "utf8")
    expect(registry).toContain("createDrizzleWebhookEndpointStore")
    expect(registry).not.toContain("dynamicQueue")
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")
    const server = await startBuiltServer(root, { ...ci.env, RECEIVER_ORIGIN: `http://127.0.0.1:${address.port}`, VITEHUB_WEBHOOKS_KEY: key }, { port })
    try {
      const post = (route: string, body: unknown) => server.fetch(route, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" })
      const secret = "whsec_member_build"
      const refused = await post("/connect", { owner: "user_ana", url: "https://127.0.0.1/hooks/abc", secret })
      expect(refused.status).toBe(400)
      expect(await refused.json()).toMatchObject({ code: "WEBHOOKS_URL_REFUSED" })
      const connected = await post("/connect", { owner: "user_ana", url: "https://203.0.113.10/hooks/abc?token=relay", secret })
      expect(await connected.json()).toMatchObject({ owner: "user_ana", host: "203.0.113.10" })

      const sent = await (await post("/send", { owner: "user_ana", body: { threads: ["thr_1"] }, key: "thr_1:msg_1" })).json() as { id: string, status: string }
      expect(sent).toEqual({ id: expect.stringMatching(/^whd_/), status: "sent" })
      expect(await (await post("/send", { owner: "user_ana", body: { threads: ["thr_1"] }, key: "thr_1:msg_1" })).json()).toEqual(sent)
      expect(received).toHaveLength(1)
      expect(received[0]!.url).toBe("/hooks/abc?token=relay")
      expect(received[0]!.headers).toMatchObject({ "x-vitehub-delivery": sent.id, "x-vitehub-event": "comments.send" })
      process.env.MEMBER_SECRET = secret
      try {
        const headers = new Headers(Object.entries(received[0]!.headers).flatMap(([name, value]) => typeof value === "string" ? [[name, value] as [string, string]] : []))
        expect(await verifyWebhook(new Request("http://127.0.0.1/hooks/abc", { body: received[0]!.body, headers, method: "POST" }), { provider: "github", secret: "MEMBER_SECRET" })).toEqual([undefined, { threads: ["thr_1"] }])
      }
      finally {
        delete process.env.MEMBER_SECRET
      }

      // The app has no `server/webhooks/` files, and the member endpoints still bring the webhooks operations.
      vi.stubEnv(`VITEHUB_CONSOLE_PRIVATE_KEY_${ci.key.name}`, ci.key.privateKey)
      onTestFinished(() => {
        vi.unstubAllEnvs()
      })
      const cli = (...args: string[]) => runCli(root, [vitehub(options), sendPlugin], ["webhooks", ...args, "--url", `http://127.0.0.1:${port}`])
      const listed = await cli("endpoints")
      expect(listed.stderr).toBe("")
      expect(listed.exitCode).toBe(0)
      expect(JSON.parse(listed.stdout)).toEqual([expect.objectContaining({ owner: "user_ana", ownerName: "Ana Ruiz", agent: "t3", host: "203.0.113.10", mine: false, last: expect.objectContaining({ state: "sent", status: 202 }) })])
      expect(listed.stdout).not.toMatch(/token=|whsec_|\/hooks|ana@example\.com/)
      const [first] = JSON.parse(listed.stdout) as Array<{ createdAt: number, id: string }>
      const next = await cli("endpoints", "--after", JSON.stringify({ createdAt: first!.createdAt, id: first!.id }))
      expect(next.stderr).toBe("")
      expect(next.exitCode).toBe(0)
      expect(JSON.parse(next.stdout)).toEqual([])
      // A CLI key names no person, so it never owns a member endpoint.
      const redelivered = await cli("redeliver", sent.id)
      expect(redelivered.exitCode).not.toBe(0)
      expect(redelivered.stderr).toContain("WEBHOOKS_DELIVERY_NOT_OWNER")
      expect(received).toHaveLength(1)
    }
    finally {
      server.close()
      await new Promise(done => receiver.close(done))
    }
  }, 300_000)

  it("resolves the verified owner of a member endpoint through Auth", async () => {
    const root = await createProject({
      ...memberFiles,
      "server/auth.ts": "import { defineAuth } from 'vite-hub/auth'\nexport default defineAuth({ database: 'memory', emailAndPassword: { enabled: true } })\n",
    })
    const options: ViteHubOptions = { auth: true, database: true, host: "node" }
    expect((await runCli(root, [vitehub(options), sendPlugin], ["database", "generate"])).exitCode).toBe(0)
    await build(root, options, [sendPlugin])
    expect(await readFile(join(root, ".vitehub/nitro/webhooks/registry.mjs"), "utf8")).toContain("resolveVerifiedOwner: findVerifiedAuthUserId,")
  }, 240_000)

  it("runs Comments `send` in a built app: tables, pairing, and a signed delivery", async () => {
    const received: Array<{ headers: IncomingHttpHeaders, body: string, url: string }> = []
    const receiver = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", chunk => chunks.push(chunk))
      request.on("end", () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8"), url: request.url ?? "" })
        response.statusCode = 202
        response.end("ok")
      })
    })
    await new Promise<void>(done => receiver.listen(0, "127.0.0.1", done))
    const address = receiver.address()
    if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")

    const root = await createProject({
      "index.html": "<!doctype html><title>Send</title>\n",
      "package.json": JSON.stringify({ name: "comments-send", private: true, type: "module" }),
      "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
      // The relay stands at a public test address. The plugin sends its requests to the local receiver.
      "server/plugins/receiver.ts": [
        "const realFetch = globalThis.fetch",
        "globalThis.fetch = (input, init) => {",
        "  const url = new URL(input instanceof Request ? input.url : String(input))",
        "  return url.hostname === '203.0.113.10' ? realFetch(`${process.env.RECEIVER_ORIGIN}${url.pathname}${url.search}`, init) : realFetch(input, init)",
        "}",
        "export default () => {}",
        "",
      ].join("\n"),
      "server/comments.ts": [
        "import { defineComments } from 'vite-hub/comments'",
        "",
        "export const comments = defineComments({",
        "  identify: ({ event }) => ({ id: event['~standard'].req.headers.get('x-user') ?? 'ana', name: 'Ana' }),",
        "  authorize: () => true,",
        "  send: { hosts: ['203.0.113.10'] },",
        "})",
        "",
      ].join("\n"),
    })
    process.chdir(root)
    process.env.PATH = `${join(import.meta.dirname, "../node_modules/.bin")}${delimiter}${path}`
    const options: ViteHubOptions = { database: true, host: "node" }
    const generate = await runCli(root, vitehub(options), ["database", "generate"])
    expect(generate.stderr).toBe("")
    expect(generate.exitCode).toBe(0)
    const migrations = join(root, "server/databases/default/migrations")
    const migration = (await readdir(migrations)).find(file => /^\d{14}_/.test(file))!
    const sql = await readFile(join(migrations, migration, "migration.sql"), "utf8")
    for (const table of ["vitehub_comment_threads", "vitehub_comment_sends", "vitehub_webhook_endpoints", "vitehub_webhook_pairings"]) expect(sql).toContain(`CREATE TABLE \`${table}\``)
    expect((await runCli(root, vitehub(options), ["database", "migrate"])).exitCode).toBe(0)

    await build(root, options)
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")
    const server = await startBuiltServer(root, { RECEIVER_ORIGIN: `http://127.0.0.1:${address.port}`, VITEHUB_WEBHOOKS_KEY: key })
    try {
      const origin = `http://127.0.0.1:${server.port}`
      const api = (route: string, body?: unknown, headers: Record<string, string> = { origin }) => server.fetch(`/_vitehub/comments${route}`, { ...body === undefined ? {} : { body: JSON.stringify(body) }, headers: { "content-type": "application/json", ...headers }, method: "POST" })
      expect((await api("/threads", { page: "/", body: "The intro is too long" })).status).toBe(200)
      const started = await (await api("/send/start?page=/")).json() as { data: { code: string, prompt: string } }
      expect(started.data.prompt).toContain(`${origin}/_vitehub/comments/send/pair`)
      // The agent posts from its own machine, with no Origin of the site.
      const paired = await api("/send/pair", { code: started.data.code, url: "https://203.0.113.10/hooks/abc?token=relay" }, { origin: "https://agent.example" })
      expect(paired.status).toBe(200)
      const allowed = await (await api("/send/allow?page=/", { code: started.data.code })).json() as { data: { status: string, id: string } }
      expect(allowed.data).toEqual({ status: "sent", id: expect.stringMatching(/^send_/) })
      expect(received).toHaveLength(1)
      expect(received[0]!.url).toBe("/hooks/abc?token=relay")
      expect(received[0]!.headers).toMatchObject({ "x-vitehub-event": "comments.send", "x-hub-signature-256": expect.stringMatching(/^sha256=[0-9a-f]{64}$/) })
      const body = JSON.parse(received[0]!.body) as { send: string, count: number, text: string, read: { url: string, token: string } }
      expect(body).toMatchObject({ send: allowed.data.id, count: 1 })
      expect(body.text).not.toContain("intro")
      const read = await server.fetch(new URL(body.read.url).pathname, { headers: { authorization: `Bearer ${body.read.token}` } })
      expect(await read.json()).toMatchObject({ data: { threads: [expect.objectContaining({ role: "ask" })] } })
    }
    finally {
      server.close()
      await new Promise(done => receiver.close(done))
    }
  }, 300_000)

  it("contributes the vitehub-webhooks Queue to the Cloudflare output", async () => {
    const root = await createProject({
      ...files,
      // D1 output needs the database id at build time.
      "server/databases/default.ts": "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ cloudflare: { binding: 'DB', databaseId: 'database-id', databaseName: 'app' }, schema: {} })\n",
    })
    const options = { database: { driver: "cloudflare" }, host: "cloudflare", queue: true } as const
    const generate = await runCli(root, vitehub(options), ["database", "generate"])
    expect(generate.stderr).toBe("")
    expect(generate.exitCode).toBe(0)
    await build(root, options)
    const wrangler = JSON.parse(await readFile(join(root, ".output/server/wrangler.json"), "utf8")) as { queues?: { producers?: Array<{ binding: string, queue: string }>, consumers?: Array<{ queue: string }> } }
    expect(wrangler.queues?.producers).toContainEqual({ binding: `QUEUE_${queueHex.toUpperCase()}`, queue: expect.stringContaining(queueHex) })
    expect(wrangler.queues?.consumers).toContainEqual(expect.objectContaining({ queue: expect.stringContaining(queueHex) }))
    expect(await readFile(join(root, ".vitehub/webhooks.d.ts"), "utf8")).toContain("\"t3\": typeof import(\"../server/webhooks/t3.ts\").default")
  }, 240_000)

  it("stores, debounces, signs, and delivers on a built Node server", async () => {
    const received: Array<{ headers: IncomingHttpHeaders, body: string }> = []
    const receiver = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", chunk => chunks.push(chunk))
      request.on("end", () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") })
        response.end("ok")
      })
    })
    await new Promise<void>(done => receiver.listen(0, "127.0.0.1", done))
    const address = receiver.address()
    if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")

    const root = await createProject(files)
    process.chdir(root)
    process.env.PATH = `${join(import.meta.dirname, "../node_modules/.bin")}${delimiter}${path}`
    const port = await freePort()
    // `console: true` takes signed operation calls, such as `vitehub webhooks --url` with a CI key.
    const options: ViteHubOptions = { console: true, database: true, host: "node", publicUrl: `http://127.0.0.1:${port}`, queue: true }
    const ci = await consoleTestKey("CI")

    const generate = await runCli(root, vitehub(options), ["database", "generate"])
    expect(generate.stderr).toBe("")
    expect(generate.exitCode).toBe(0)
    const migrations = join(root, "server/databases/default/migrations")
    const migration = (await readdir(migrations)).find(file => /^\d{14}_/.test(file))!
    expect(await readFile(join(migrations, migration, "migration.sql"), "utf8")).toContain("CREATE TABLE `vitehub_webhook_deliveries`")
    const migrate = await runCli(root, vitehub(options), ["database", "migrate"])
    expect(migrate.stderr).toBe("")
    expect(migrate.exitCode).toBe(0)

    await build(root, options)
    const secret = "whsec_build_test"
    const server = await startBuiltServer(root, { ...ci.env, T3_WEBHOOK_SECRET: secret, T3_WEBHOOK_URL: `http://127.0.0.1:${address.port}/hook?token=relay` }, { port })
    try {
      const ids: string[] = []
      for (const comment of ["first", "second", "third"]) {
        const response = await server.fetch("/comment", { body: JSON.stringify({ comment }), headers: { "content-type": "application/json" }, method: "POST" })
        expect(response.status).toBe(200)
        ids.push((await response.json() as { id: string }).id)
      }
      expect(new Set(ids).size).toBe(1)
      await vi.waitFor(() => expect(received).toHaveLength(1), { interval: 100, timeout: 15_000 })
      await new Promise(done => setTimeout(done, 1_500))
      expect(received).toHaveLength(1)
      const [delivery] = received
      expect(JSON.parse(delivery!.body)).toEqual({ comment: "third" })
      expect(delivery!.headers).toMatchObject({ "x-vitehub-delivery": ids[0], "x-vitehub-event": "comments.comment", "x-vitehub-events": "3" })
      process.env.T3_WEBHOOK_SECRET = secret
      try {
        const headers = new Headers(Object.entries(delivery!.headers).flatMap(([name, value]) => typeof value === "string" ? [[name, value] as [string, string]] : []))
        expect(await verifyWebhook(new Request("http://127.0.0.1/hook", { body: delivery!.body, headers, method: "POST" }), { provider: "github", secret: "T3_WEBHOOK_SECRET" })).toEqual([undefined, { comment: "third" }])
      }
      finally {
        delete process.env.T3_WEBHOOK_SECRET
      }
      await vi.waitFor(async () => expect(await (await server.fetch("/deliveries")).json()).toEqual([expect.objectContaining({ id: ids[0], state: "sent", count: 3, attempts: 1 })]), { interval: 100, timeout: 5_000 })

      // `vitehub webhooks` reads and operates the same deliveries through the signed operation RPC of the built app.
      vi.stubEnv(`VITEHUB_CONSOLE_PRIVATE_KEY_${ci.key.name}`, ci.key.privateKey)
      onTestFinished(() => {
        vi.unstubAllEnvs()
      })
      const cli = async (...args: string[]) => {
        const result = await runCli(root, vitehub(options), ["webhooks", ...args, "--url", `http://127.0.0.1:${port}`])
        expect(result.stderr).toBe("")
        expect(result.exitCode).toBe(0)
        return JSON.parse(result.stdout) as unknown
      }
      const listed = await cli("list")
      expect(listed).toEqual([{ name: "t3", url: "T3_WEBHOOK_URL", secret: "T3_WEBHOOK_SECRET", signature: "github", debounceMs: 1_000, events: [], urlSet: true, secretSet: true, host: `127.0.0.1:${address.port}` }])
      expect(JSON.stringify(listed)).not.toMatch(/relay|whsec_|\/hook/)
      expect(await cli("deliveries", "--webhook", "t3", "--state", "sent")).toEqual([expect.objectContaining({ id: ids[0], count: 3 })])
      const tested = await cli("test", "t3", "--body", "{\"ping\":1}") as { id: string }
      await vi.waitFor(() => expect(received).toHaveLength(2), { interval: 100, timeout: 15_000 })
      expect(received[1]!.headers).toMatchObject({ "x-vitehub-delivery": tested.id, "x-vitehub-event": "webhooks.test" })
      expect(JSON.parse(received[1]!.body)).toEqual({ ping: 1 })
      const redelivered = await cli("redeliver", ids[0]!) as { id: string }
      await vi.waitFor(() => expect(received).toHaveLength(3), { interval: 100, timeout: 15_000 })
      expect(received[2]!.headers["x-vitehub-delivery"]).toBe(redelivered.id)
      expect(await cli("pending")).toEqual([])
    }
    finally {
      server.close()
      await new Promise(done => receiver.close(done))
    }
  }, 300_000)
  // The registry also holds a placeholder `default` that throws. Webhooks and Forms must use the Database that
  // `vitehub database generate` adds their tables to, here the only one, `content`.
  it("uses the only Database when it is not named default", async () => {
    const received: string[] = []
    const receiver = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", chunk => chunks.push(chunk))
      request.on("end", () => {
        received.push(Buffer.concat(chunks).toString("utf8"))
        response.end("ok")
      })
    })
    await new Promise<void>(done => receiver.listen(0, "127.0.0.1", done))
    const address = receiver.address()
    if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")

    const root = await createProject({
      ...files,
      "server/webhooks/t3.ts": "import { defineWebhook } from 'vite-hub/webhooks'\nexport default defineWebhook({ url: 'T3_WEBHOOK_URL', secret: 'T3_WEBHOOK_SECRET' })\n",
      "server/databases/content.ts": "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ name: 'content', schema: {} })\n",
      "server/forms/contact.ts": "import * as v from 'valibot'\nimport { defineForm } from 'vite-hub/forms'\nexport default defineForm({ schema: v.object({ message: v.string() }) })\n",
      "server/routes/inbox.get.ts": "import { installedForms } from 'vite-hub/forms/runtime'\nexport default { fetch: async () => Response.json((await installedForms()!.inbox.list())[1]) }\n",
    })
    process.chdir(root)
    process.env.PATH = `${join(import.meta.dirname, "../node_modules/.bin")}${delimiter}${path}`
    const options: ViteHubOptions = { database: true, host: "node", queue: true }
    const generate = await runCli(root, vitehub(options), ["database", "generate"])
    expect(generate.exitCode).toBe(0)
    const migrations = join(root, "server/databases/content/migrations")
    const migration = (await readdir(migrations)).find(file => /^\d{14}_/.test(file))!
    const sql = await readFile(join(migrations, migration, "migration.sql"), "utf8")
    expect(sql).toContain("CREATE TABLE `vitehub_webhook_deliveries`")
    expect(sql).toContain("CREATE TABLE `vitehub_form_submissions`")
    expect((await runCli(root, vitehub(options), ["database", "migrate"])).exitCode).toBe(0)

    await build(root, options)
    const server = await startBuiltServer(root, { T3_WEBHOOK_SECRET: "whsec_content", T3_WEBHOOK_URL: `http://127.0.0.1:${address.port}/hook` })
    try {
      const sent = await server.fetch("/comment", { body: JSON.stringify({ comment: "on content" }), headers: { "content-type": "application/json" }, method: "POST" })
      expect(await sent.json()).toEqual({ id: expect.stringMatching(/^whd_/), status: "pending" })
      await vi.waitFor(() => expect(received).toEqual([JSON.stringify({ comment: "on content" })]), { interval: 100, timeout: 15_000 })
      await vi.waitFor(async () => expect(await (await server.fetch("/deliveries")).json()).toEqual([expect.objectContaining({ state: "sent" })]), { interval: 100, timeout: 5_000 })

      const form = await server.fetch("/_vitehub/forms/contact", { body: JSON.stringify({ message: "Hi" }), headers: { "content-type": "application/json", "referer": `http://127.0.0.1:${server.port}/` }, method: "POST" })
      expect(`${form.status} ${await form.text()}`).toMatch(/^201 /)
      expect(await (await server.fetch("/inbox")).json()).toEqual([expect.objectContaining({ data: { message: "Hi" } })])
    }
    finally {
      server.close()
      await new Promise(done => receiver.close(done))
    }
  }, 300_000)
  // The registry also holds a placeholder `default` that throws. Webhooks and Forms must use the Database that
  // `vitehub database generate` adds their tables to, here the only one, `content`.
  it("uses the only Database when it is not named default", async () => {
    const received: string[] = []
    const receiver = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", chunk => chunks.push(chunk))
      request.on("end", () => {
        received.push(Buffer.concat(chunks).toString("utf8"))
        response.end("ok")
      })
    })
    await new Promise<void>(done => receiver.listen(0, "127.0.0.1", done))
    const address = receiver.address()
    if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")

    const root = await createProject({
      ...files,
      "server/webhooks/t3.ts": "import { defineWebhook } from 'vite-hub/webhooks'\nexport default defineWebhook({ url: 'T3_WEBHOOK_URL', secret: 'T3_WEBHOOK_SECRET' })\n",
      "server/databases/content.ts": "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ name: 'content', schema: {} })\n",
      "server/forms/contact.ts": "import * as v from 'valibot'\nimport { defineForm } from 'vite-hub/forms'\nexport default defineForm({ schema: v.object({ message: v.string() }) })\n",
      "server/routes/inbox.get.ts": "import { installedForms } from 'vite-hub/forms/runtime'\nexport default { fetch: async () => Response.json((await installedForms()!.inbox.list())[1]) }\n",
    })
    process.chdir(root)
    process.env.PATH = `${join(import.meta.dirname, "../node_modules/.bin")}${delimiter}${path}`
    const options: ViteHubOptions = { database: true, host: "node", queue: true }
    const generate = await runCli(root, vitehub(options), ["database", "generate"])
    expect(generate.exitCode).toBe(0)
    const migrations = join(root, "server/databases/content/migrations")
    const migration = (await readdir(migrations)).find(file => /^\d{14}_/.test(file))!
    const sql = await readFile(join(migrations, migration, "migration.sql"), "utf8")
    expect(sql).toContain("CREATE TABLE `vitehub_webhook_deliveries`")
    expect(sql).toContain("CREATE TABLE `vitehub_form_submissions`")
    expect((await runCli(root, vitehub(options), ["database", "migrate"])).exitCode).toBe(0)

    await build(root, options)
    const server = await startBuiltServer(root, { T3_WEBHOOK_SECRET: "whsec_content", T3_WEBHOOK_URL: `http://127.0.0.1:${address.port}/hook` })
    try {
      const sent = await server.fetch("/comment", { body: JSON.stringify({ comment: "on content" }), headers: { "content-type": "application/json" }, method: "POST" })
      expect(await sent.json()).toEqual({ id: expect.stringMatching(/^whd_/), status: "pending" })
      await vi.waitFor(() => expect(received).toEqual([JSON.stringify({ comment: "on content" })]), { interval: 100, timeout: 15_000 })
      await vi.waitFor(async () => expect(await (await server.fetch("/deliveries")).json()).toEqual([expect.objectContaining({ state: "sent" })]), { interval: 100, timeout: 5_000 })

      const form = await server.fetch("/_vitehub/forms/contact", { body: JSON.stringify({ message: "Hi" }), headers: { "content-type": "application/json", "referer": `http://127.0.0.1:${server.port}/` }, method: "POST" })
      expect(`${form.status} ${await form.text()}`).toMatch(/^201 /)
      expect(await (await server.fetch("/inbox")).json()).toEqual([expect.objectContaining({ data: { message: "Hi" } })])
    }
    finally {
      server.close()
      await new Promise(done => receiver.close(done))
    }
  }, 300_000)
})
