import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createEmailCliContributor, runEmailOutboxCli, runEmailPreviewCli } from "../src/cli.ts"
import { emailDevHeader, emailDevHeaderValue, emailDevRoute, emailDevRuntimeRoute } from "../src/dev.ts"
import { emailDevRuntimeUnavailableMessage, registerEmailDevEndpoint } from "../src/vite-dev.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ViteHubNitroDevServer } from "@vite-hub/internal/dev-endpoint"
import type { EmailOutboxMessage } from "../src/runtime/console.ts"

const rootDir = "/app"
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

function context(root = rootDir) {
  const stdout = stream()
  const stderr = stream()
  return { context: { cwd: root, env: {}, rootDir: root, stderr, stdout }, stderr, stdout }
}

/** Fake dev server: `GET` discovery, then one `POST` operation. */
function devServer(result: unknown, init: { discovery?: Record<string, unknown>, status?: number } = {}) {
  return vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST"
    ? Response.json(result, { status: init.status ?? 200 })
    : Response.json(init.discovery ?? { root: rootDir, runtime: "nitro" }))
}

const captured: EmailOutboxMessage = {
  attachments: [{ contentType: "application/pdf", filename: "invoice.pdf", size: 2048 }],
  capturedAt: "2026-09-29T10:00:00.000Z",
  delivery: { status: "captured" },
  from: "hello@example.com",
  headers: { "List-Unsubscribe": "<https://example.com/u?token=[redacted]>", "X-Api-Key": "[redacted]" },
  html: "<p>Your invoice.</p>",
  id: "outbox-2",
  provider: "resend",
  subject: "Invoice",
  text: "Your invoice.",
  to: ["ada@example.com"],
}

const listResult = {
  limit: 50,
  messages: [
    { attachments: 1, capturedAt: "2026-09-29T10:00:00.000Z", delivery: { status: "captured" }, from: "hello@example.com", id: "outbox-2", provider: "resend", subject: "Invoice", to: ["ada@example.com"] },
    { attachments: 0, capturedAt: "2026-09-29T09:00:00.000Z", delivery: { id: "re_1", status: "sent" }, from: "hello@example.com", id: "outbox-1", provider: "resend", subject: "Welcome", to: ["grace@example.com"] },
  ],
}

describe("Email discovery failure output", () => {
  it.each([["show", "--json"], ["list", "--json", "--html"], ["send", "--json"], ["--json"]])("returns JSON for outbox argument errors: %j", async (...args) => {
    const output = context()
    const fetch = vi.fn()
    await expect(runEmailOutboxCli(args, output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toEqual({ error: { message: expect.any(String) } })
    expect(output.stderr.output()).toBe("")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([{ flags: [] }, { flags: ["--json"] }])("reports malformed outbox rows with flags %j", async ({ flags }) => {
    const output = context()
    await expect(runEmailOutboxCli(["list", ...flags], output.context, { fetch: devServer({ ...listResult, messages: [{}] }) })).resolves.toBe(1)
    expect(output.stdout.output() + output.stderr.output()).toContain("response is invalid")
  })

  it("prints a JSON error without stderr diagnostics", async () => {
    const output = context()
    await expect(runEmailOutboxCli(["list", "--json"], output.context, { fetch: vi.fn(async () => { throw new Error("offline") }) })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toHaveProperty("error.message")
    expect(output.stderr.output()).toBe("")
  })

  it("applies timeout to discovery", async () => {
    const output = context()
    const fetch = vi.fn((_url: string | URL | Request, request?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true })
    }))
    await expect(runEmailOutboxCli(["list", "--json", "--timeout", "10"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toHaveProperty("error.message")
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("keeps a valid discovery root when another field is malformed", async () => {
    const output = context()
    const fetch = devServer({}, { discovery: { root: "/other", runtime: 123 } })
    await expect(runEmailOutboxCli(["list"], output.context, { fetch })).resolves.toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls).toHaveLength(1)
  })

  it("rejects a malformed discovery root", async () => {
    const output = context()
    const fetch = devServer({}, { discovery: { root: 123 } })
    await expect(runEmailOutboxCli(["list"], output.context, { fetch })).resolves.toBe(1)
    expect(output.stderr.output()).toContain("Invalid Vite Development Server discovery root.")
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe("vitehub email outbox", () => {
  it("lists captured messages as a table and as JSON", async () => {
    const human = context()
    const fetch = devServer(listResult)
    await expect(runEmailOutboxCli(["list", "--url", "http://127.0.0.1:4321"], human.context, { fetch })).resolves.toBe(0)

    expect(human.stdout.output()).toBe([
      "ID        CAPTURED                  PROVIDER  DELIVERY   TO                 SUBJECT",
      "outbox-2  2026-09-29T10:00:00.000Z  resend    captured   ada@example.com    Invoice",
      "outbox-1  2026-09-29T09:00:00.000Z  resend    sent re_1  grace@example.com  Welcome",
      "2 messages (limit 50).",
      "",
    ].join("\n"))
    const [discovery, operation] = fetch.mock.calls
    expect(String(discovery?.[0])).toBe(`http://127.0.0.1:4321${emailDevRoute}`)
    expect(operation?.[1]).toMatchObject({
      body: JSON.stringify({ operation: "list" }),
      headers: { "content-type": "application/json", [emailDevHeader]: emailDevHeaderValue },
      method: "POST",
    })

    const json = context()
    await expect(runEmailOutboxCli(["list", "--json"], json.context, { fetch: devServer(listResult) })).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output())).toEqual(listResult)

    const empty = context()
    await expect(runEmailOutboxCli(["list"], empty.context, { fetch: devServer({ limit: null, messages: [] }) })).resolves.toBe(0)
    expect(empty.stdout.output()).toBe("No captured messages.\n")
  })

  it("shows one message as a summary, HTML, text, or JSON", async () => {
    const human = context()
    const fetch = devServer({ message: captured })
    await expect(runEmailOutboxCli(["show", "outbox-2"], human.context, { fetch })).resolves.toBe(0)
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ body: JSON.stringify({ id: "outbox-2", operation: "get" }) })
    expect(human.stdout.output()).toBe([
      "Message: outbox-2",
      "Captured: 2026-09-29T10:00:00.000Z",
      "Provider: resend",
      "Delivery: captured",
      "From: hello@example.com",
      "To: ada@example.com",
      "Subject: Invoice",
      "Headers:",
      "  List-Unsubscribe: <https://example.com/u?token=[redacted]>",
      "  X-Api-Key: [redacted]",
      "Attachments:",
      "  invoice.pdf (application/pdf, 2048 bytes)",
      "HTML: 20 characters. Use --html to print it.",
      "",
      "Your invoice.",
      "",
    ].join("\n"))

    const html = context()
    await expect(runEmailOutboxCli(["show", "outbox-2", "--html"], html.context, { fetch: devServer({ message: captured }) })).resolves.toBe(0)
    expect(html.stdout.output()).toBe("<p>Your invoice.</p>\n")

    const text = context()
    await expect(runEmailOutboxCli(["show", "--text", "outbox-2"], text.context, { fetch: devServer({ message: captured }) })).resolves.toBe(0)
    expect(text.stdout.output()).toBe("Your invoice.\n")

    const json = context()
    await expect(runEmailOutboxCli(["show", "outbox-2", "--json"], json.context, { fetch: devServer({ message: captured }) })).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output())).toEqual(captured)
  })

  it("shows the failed delivery reason", async () => {
    const failed = context()
    const message = { ...captured, delivery: { error: { code: "AUTH", message: "Invalid key." }, status: "failed" } }
    await expect(runEmailOutboxCli(["show", "outbox-2"], failed.context, { fetch: devServer({ message }) })).resolves.toBe(0)
    expect(failed.stdout.output()).toContain("Delivery: failed AUTH: Invalid key.\n")
  })

  it("clears the outbox", async () => {
    const human = context()
    const fetch = devServer({ cleared: 2 })
    await expect(runEmailOutboxCli(["clear"], human.context, { fetch })).resolves.toBe(0)
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ body: JSON.stringify({ operation: "clear" }) })
    expect(human.stdout.output()).toBe("Removed 2 messages from the outbox.\n")

    const json = context()
    await expect(runEmailOutboxCli(["clear", "--json"], json.context, { fetch: devServer({ cleared: 1 }) })).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output())).toEqual({ cleared: 1 })
  })

  it("prints runtime failures as text or JSON", async () => {
    const error = { error: { code: "EMAIL_OUTBOX_MESSAGE_NOT_FOUND", message: "Outbox message was not found." } }
    const human = context()
    await expect(runEmailOutboxCli(["show", "outbox-9"], human.context, { fetch: devServer(error, { status: 404 }) })).resolves.toBe(1)
    expect(human.stderr.output()).toBe("Outbox message was not found.\n")

    const json = context()
    await expect(runEmailOutboxCli(["show", "outbox-9", "--json"], json.context, { fetch: devServer(error, { status: 404 }) })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toEqual(error)

    const disabled = context()
    const disabledError = { error: { code: "EMAIL_OUTBOX_DISABLED", message: "The Email development outbox is disabled." } }
    await expect(runEmailOutboxCli(["list", "--json"], disabled.context, { fetch: devServer(disabledError, { status: 409 }) })).resolves.toBe(1)
    expect(JSON.parse(disabled.stdout.output())).toEqual(disabledError)
  })

  it("explains hosts that cannot reach the Email runtime", async () => {
    const unavailable = context()
    const fetch = devServer({}, { discovery: { message: emailDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable" } })
    await expect(runEmailOutboxCli(["list", "--json"], unavailable.context, { fetch })).resolves.toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(unavailable.stdout.output())).toEqual({
      error: { code: "EMAIL_DEV_RUNTIME_UNAVAILABLE", message: emailDevRuntimeUnavailableMessage },
    })

    const missing = context()
    await expect(runEmailOutboxCli(["list"], missing.context, { fetch: vi.fn(async () => new Response("Not found", { status: 404 })) })).resolves.toBe(1)
    expect(missing.stderr.output()).toContain("`vitehub email outbox` needs a running Vite + Nitro Development Server with `email` enabled. Nuxt and plain Vite are not supported.\n")
  })

  it("validates arguments before it calls the server", async () => {
    const fetch = vi.fn()
    const missingId = context()
    await expect(runEmailOutboxCli(["show"], missingId.context, { fetch })).resolves.toBe(1)
    expect(missingId.stderr.output()).toContain("Missing outbox message id.")
    const formats = context()
    await expect(runEmailOutboxCli(["show", "outbox-1", "--html", "--text"], formats.context, { fetch })).resolves.toBe(1)
    expect(formats.stderr.output()).toContain("Use only one of --html, --text, and --json.")
    const unknown = context()
    await expect(runEmailOutboxCli(["list", "--html"], unknown.context, { fetch })).resolves.toBe(1)
    expect(unknown.stderr.output()).toContain("Unknown option: --html.")
    const command = context()
    await expect(runEmailOutboxCli(["send"], command.context, { fetch })).resolves.toBe(1)
    expect(command.stderr.output()).toContain("Unknown outbox command: send")
    const none = context()
    await expect(runEmailOutboxCli([], none.context, { fetch })).resolves.toBe(1)
    expect(none.stderr.output()).toContain("Usage: vitehub email outbox <list|show|clear>")
    const help = context()
    await expect(runEmailOutboxCli(["show", "--help"], help.context, { fetch })).resolves.toBe(0)
    expect(help.stdout.output()).toContain("Usage: vitehub email outbox show <id> [--html|--text|--json] [--url <url>]")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("contributes the outbox and preview features", () => {
    const [namespace] = createEmailCliContributor().namespaces
    expect(namespace?.name).toBe("email")
    expect(namespace?.features.map(feature => feature.name)).toEqual(["outbox", "preview"])
  })
})

async function templateProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-email-cli-"))
  tempDirs.push(root)
  await mkdir(join(root, "server", "emails", "billing"), { recursive: true })
  await writeFile(join(root, "server", "emails", "welcome.md"), "# Hello {{ data.name }}\n\nWelcome to **ViteHub**.\n")
  await writeFile(join(root, "server", "emails", "billing", "receipt.md"), "Receipt {{ data.id }}\n")
  return root
}

describe("vitehub email preview", () => {
  it("renders a template with inline JSON data", async () => {
    const root = await templateProject()
    const human = context(root)
    await expect(runEmailPreviewCli(["welcome", "--data", "{\"name\":\"Ada\"}"], human.context)).resolves.toBe(0)
    expect(human.stdout.output()).toBe([
      "Template: welcome",
      "File: server/emails/welcome.md",
      "",
      "Text:",
      "# Hello Ada\n\nWelcome to **ViteHub**.",
      "",
      "HTML:",
      "<h1 id=\"hello-ada\">Hello Ada</h1>\n<p>Welcome to <strong>ViteHub</strong>.</p>",
      "",
    ].join("\n"))

    const html = context(root)
    await expect(runEmailPreviewCli(["welcome", "--html", "--data={\"name\":\"Ada\"}"], html.context)).resolves.toBe(0)
    expect(html.stdout.output()).toBe("<h1 id=\"hello-ada\">Hello Ada</h1>\n<p>Welcome to <strong>ViteHub</strong>.</p>\n")

    const text = context(root)
    await expect(runEmailPreviewCli(["welcome", "--text", "--data", "{\"name\":\"Ada\"}"], text.context)).resolves.toBe(0)
    expect(text.stdout.output()).toBe("# Hello Ada\n\nWelcome to **ViteHub**.\n")
  })

  it("reads data from a file and prints JSON", async () => {
    const root = await templateProject()
    await writeFile(join(root, "receipt.json"), JSON.stringify({ id: "r_42" }))
    const json = context(root)
    await expect(runEmailPreviewCli(["billing/receipt", "--data", "@receipt.json", "--json"], json.context)).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output())).toEqual({
      file: join("server", "emails", "billing", "receipt.md"),
      html: "<p>Receipt r_42</p>",
      template: "billing/receipt",
      text: "Receipt r_42",
    })
  })

  it("uses the template roots of the Vite plugin", async () => {
    const root = await templateProject()
    const other = context("/elsewhere")
    const preview = runEmailPreviewCli(["billing/receipt", "--text", "--data", "{\"id\":\"r_7\"}"], other.context, { templateRoots: () => [join(root, "server", "emails")] })
    await expect(preview).resolves.toBe(0)
    expect(other.stderr.output()).toBe("")
    expect(other.stdout.output()).toBe("Receipt r_7\n")
  })

  it("reports missing templates and invalid data", async () => {
    const root = await templateProject()
    const missing = context(root)
    await expect(runEmailPreviewCli(["goodbye", "--json"], missing.context)).resolves.toBe(1)
    expect(JSON.parse(missing.stdout.output())).toEqual({
      error: {
        code: "EMAIL_TEMPLATE_NOT_FOUND",
        message: "Email template \"goodbye\" was not found in server/emails. Templates: billing/receipt, welcome.",
      },
    })

    const invalid = context(root)
    await expect(runEmailPreviewCli(["welcome", "--data", "{"], invalid.context)).resolves.toBe(1)
    expect(invalid.stderr.output()).toContain("--data must be valid JSON.")

    const array = context(root)
    await expect(runEmailPreviewCli(["welcome", "--data", "[]"], array.context)).resolves.toBe(1)
    expect(array.stderr.output()).toContain("--data must be a JSON object.")

    const file = context(root)
    await expect(runEmailPreviewCli(["welcome", "--data", "@missing.json"], file.context)).resolves.toBe(1)
    expect(file.stderr.output()).toContain("Cannot read --data file \"missing.json\".")

    const usage = context(root)
    await expect(runEmailPreviewCli([], usage.context)).resolves.toBe(1)
    expect(usage.stderr.output()).toContain("Missing template name.")
  })
})

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

function fakeServer(environments?: Record<string, unknown>) {
  const middlewares: Middleware[] = []
  const server: ViteHubNitroDevServer = {
    config: { root: rootDir, server: { port: 5173 } },
    environments,
    middlewares: { use: handler => middlewares.push(handler) },
  }
  return { middlewares, server }
}

async function call(middleware: Middleware, init: { body?: string, headers?: Record<string, string>, method: string }) {
  const req = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
    headers: { host: "localhost:5173", ...init.headers },
    method: init.method,
    url: emailDevRoute,
  }) as unknown as IncomingMessage
  const done = new EventEmitter()
  const chunks: Buffer[] = []
  const headers: Record<string, string> = {}
  const res = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
    final(callback) {
      done.emit("end")
      callback()
    },
  }), {
    setHeader(name: string, value: string) {
      headers[name] = value
    },
    statusCode: 200,
  })
  const ended = new Promise(resolve => done.once("end", resolve))
  middleware(req, res as unknown as ServerResponse, () => done.emit("end"))
  await ended
  return { body: Buffer.concat(chunks).toString("utf8"), headers, status: res.statusCode }
}

const guard = { [emailDevHeader]: emailDevHeaderValue }

describe("Email dev endpoint", () => {
  it("rejects requests without the guard header or from another origin", async () => {
    const { middlewares, server } = fakeServer()
    registerEmailDevEndpoint(server)

    expect(await call(middlewares[0]!, { method: "GET" })).toMatchObject({ body: "Forbidden Email Dev request.", status: 403 })
    expect(await call(middlewares[0]!, { headers: { ...guard, origin: "https://attacker.test" }, method: "GET" })).toMatchObject({ status: 403 })
    expect(await call(middlewares[0]!, { body: "{}", headers: { ...guard, "content-type": "text/plain" }, method: "POST" })).toMatchObject({ status: 415 })
    expect(await call(middlewares[0]!, { headers: guard, method: "DELETE" })).toMatchObject({ status: 405 })
  })

  it("reports hosts without an in-process Nitro environment", async () => {
    const { middlewares, server } = fakeServer()
    registerEmailDevEndpoint(server)

    const discovery = await call(middlewares[0]!, { headers: guard, method: "GET" })
    expect(JSON.parse(discovery.body)).toEqual({ message: emailDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable" })
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"list\"}", headers: { ...guard, "content-type": "application/json" }, method: "POST" })
    expect(operation.status).toBe(501)
    expect(JSON.parse(operation.body)).toMatchObject({ error: { code: "EMAIL_DEV_RUNTIME_UNAVAILABLE" } })
  })

  it("forwards operations into the Nitro environment under the Nitro base URL", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => Response.json({ body: await request.text(), url: request.url }))
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    registerEmailDevEndpoint(server, { nitroBaseURL: () => "/app/" })

    expect(JSON.parse((await call(middlewares[0]!, { headers: guard, method: "GET" })).body)).toEqual({ root: rootDir, runtime: "nitro" })
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"list\"}", headers: { ...guard, "content-type": "application/json" }, method: "POST" })

    expect(operation.status).toBe(200)
    expect(operation.headers["cache-control"]).toBe("no-store")
    expect(JSON.parse(operation.body)).toEqual({ body: "{\"operation\":\"list\"}", url: `http://localhost/app${emailDevRuntimeRoute}` })
    expect(dispatchFetch.mock.calls[0]?.[0].headers.get(emailDevHeader)).toBe(emailDevHeaderValue)
  })
})
