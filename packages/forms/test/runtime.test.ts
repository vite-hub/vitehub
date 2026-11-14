import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as v from "valibot"
import { describe, expect, it } from "vitest"

import { defineForm } from "../src/index.ts"
import { addressKey, createFormsHandler, installedForms, memoryFormRateLimit } from "../src/runtime.ts"
import { discoverForms, hubForms, renderFormsHandler, storingForms } from "../src/vite.ts"

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "vitehub-forms-"))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

describe("discoverForms", () => {
  it("finds server/forms/<name> files, sorted, without declarations", () => {
    const root = app({ "server/forms/contact.ts": "", "server/forms/bug-report.mjs": "", "server/forms/types.d.ts": "", "server/forms/nested/x.ts": "" })
    expect(discoverForms(root).map(form => form.name)).toEqual(["bug-report", "contact"])
    expect(discoverForms(app({}))).toEqual([])
  })

  it("rejects names that are not a route segment and duplicates", () => {
    expect(() => discoverForms(app({ "server/forms/Contact Us.ts": "" }))).toThrow("lowercase letters, digits, and dashes")
    expect(() => discoverForms(app({ "server/forms/contact.ts": "", "server/forms/contact.mjs": "" }))).toThrow("Two files define the form \"contact\"")
  })
})

describe("renderFormsHandler", () => {
  it("imports only the services the app has", () => {
    const forms = [{ name: "contact", file: "/app/server/forms/contact.ts" }]
    const imports = { runtime: "vite-hub/forms/runtime", operations: "vite-hub/forms/operations", database: "vite-hub/forms/database", databases: "@vite-hub/database/runtime/registry", email: "vite-hub/email", auth: "vite-hub/auth/server", standard: "vite-hub/runtime" }
    const bare = renderFormsHandler(forms, { imports })
    expect(bare).not.toContain("databases")
    expect(bare).not.toContain("email")
    expect(bare).toContain("import form0 from \"/app/server/forms/contact.ts\"")
    const full = renderFormsHandler(forms, { imports, database: true, email: true, auth: true })
    expect(full).toContain("import { databases } from \"@vite-hub/database/runtime/registry\"")
    expect(full).toContain("sendEmail: message => email.send(message),")
    expect(full).toContain("import { useAuth } from \"vite-hub/auth/server\"")
    expect(full).toContain("useAuth(request).api.getSession({ headers: request.headers })")
  })
})

describe("hubForms without a Database", () => {
  const storing = "import { defineForm } from '@vite-hub/forms'\nexport default defineForm({ schema })\n"
  const notifying = "import { defineForm } from '@vite-hub/forms'\nexport default defineForm({ schema, store: false, notify: { email: { to: 'a@b.c' } } })\n"
  const configure = async (root: string, command: "build" | "serve") => {
    const plugin = hubForms()
    const handler = (plugin.config as { handler: (config: object, env: { command: string, mode: string }) => Promise<void> }).handler
    await handler({ root }, { command, mode: command === "build" ? "production" : "development" })
    return root
  }

  it("fails a build when a form stores submissions", async () => {
    const root = app({ "server/forms/contact.ts": storing, "server/forms/notify.ts": notifying })
    expect(storingForms(discoverForms(root)).map(form => form.name)).toEqual(["contact"])
    await expect(configure(root, "build")).rejects.toMatchObject({ code: "FORMS_B0002", message: expect.stringContaining("server/forms/contact.ts") })
  })

  it.each([
    ["store: false, ...{ store: true }", true],
    ["store: false, [key]: true", true],
    ["store: false, [key]: false", true],
    ["...options, store: false", false],
    ["[key]: true, store: false", false],
    ["store: false, ['store']: true", true],
    ["store: false, ['notify']: notify", false],
  ])("classifies overrides in source order: %s", (members, stores) => {
    const root = app({ "server/forms/contact.ts": `export default defineForm({ schema, ${members} })` })
    expect(storingForms(discoverForms(root)).length > 0).toBe(stores)
  })

  it("builds when every form sets store: false", async () => {
    const root = await configure(app({ "server/forms/notify.ts": notifying }), "build")
    expect(readFileSync(join(root, ".vitehub/nitro/forms/handler.mjs"), "utf8")).not.toContain("memory")
  })

  it("keeps submissions in memory on a development server", async () => {
    const root = await configure(app({ "server/forms/contact.ts": storing }), "serve")
    expect(readFileSync(join(root, ".vitehub/nitro/forms/handler.mjs"), "utf8")).toContain("memory: true,")
  })
})

describe("addressKey", () => {
  it("counts an IPv6 address as its /64 network and keeps IPv4 as it is", () => {
    expect(addressKey("2001:db8:1:2::1")).toBe(addressKey("2001:0db8:0001:0002:aaaa::5"))
    expect(addressKey("2001:db8:1:2::1")).not.toBe(addressKey("2001:db8:1:3::1"))
    expect(addressKey("1.2.3.4")).toBe("1.2.3.4")
  })
})

describe("createFormsHandler", () => {
  const contact = defineForm({ schema: v.object({ message: v.string() }), rateLimit: { limit: 2, window: "1m" } })
  const post = (name: string, address = "1.1.1.1") => {
    const request = new Request(`https://site.test/api/_vitehub/forms/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Hi" }) })
    return { request, address }
  }

  it("routes by the last path segment, limits each address, and installs the inbox", async () => {
    let address = "1.1.1.1"
    const handler = createFormsHandler({ forms: { contact }, memory: true, context: () => ({ runtime: { clientAddress: address } }) })
    expect((await handler.fetch(post("missing").request)).status).toBe(404)
    expect((await handler.fetch(post("%E0").request)).status).toBe(404)
    expect((await handler.fetch(post("contact").request)).status).toBe(201)
    expect((await handler.fetch(post("contact").request)).status).toBe(201)
    expect((await handler.fetch(post("contact").request)).status).toBe(429)
    address = "2.2.2.2"
    expect((await handler.fetch(post("contact").request)).status).toBe(201)
    const installed = installedForms()
    expect(installed?.names).toEqual(["contact"])
    const [, listed] = await installed!.inbox.list()
    expect(listed).toHaveLength(3)
  })

  it("answers 503 without a Database or memory, and stores nothing", async () => {
    const handler = createFormsHandler({ forms: { contact } })
    expect((await handler.fetch(post("contact").request)).status).toBe(503)
    const [, listed] = await installedForms()!.inbox.list()
    expect(listed).toEqual([])
  })

  it("throws the email error so the handler logs it", async () => {
    const form = defineForm({ schema: v.object({ message: v.string() }), store: false, notify: { email: { to: "a@b.c" } } })
    const handler = createFormsHandler({ forms: { form }, sendEmail: async () => [new Error("down"), undefined] })
    expect((await handler.fetch(post("form").request)).status).toBe(502)
  })

  it.each([false, true])("trusts the Cloudflare address only on Cloudflare (host: %s)", async (cloudflare) => {
    const handler = createFormsHandler({ forms: { contact }, memory: true, context: () => ({ runtime: cloudflare ? { cloudflare: { env: {} } } : {} }) })
    const send = (address: string) => {
      const { request } = post("contact")
      request.headers.set("cf-connecting-ip", address)
      return handler.fetch(request)
    }
    expect((await send("1.1.1.1")).status).toBe(201)
    expect((await send("1.1.1.1")).status).toBe(201)
    expect((await send("2.2.2.2")).status).toBe(cloudflare ? 201 : 429)
  })
})

it("memoryFormRateLimit opens a new window after the old one ends", () => {
  let now = 0
  const limit = memoryFormRateLimit(() => now)
  const policy = { limit: 1, window: "1s" }
  expect(limit("k", policy).allowed).toBe(true)
  expect(limit("k", policy)).toEqual({ allowed: false, retryAfter: 1 })
  now = 1000
  expect(limit("k", policy).allowed).toBe(true)
})

it("createFormsHandler rejects a file that does not default-export defineForm()", () => {
  expect(() => createFormsHandler({ forms: { contact: { schema: {} } } })).toThrow("server/forms/contact must default-export defineForm")
})
