import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createEmail } from "../src/client.ts"
import logEmailDriver from "../src/drivers/log.ts"
import { hubEmail } from "../src/vite.ts"

import type { EmailDefinition, EmailMessage } from "../src/types.ts"

type ConfigHook = (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
type ConfigResolvedHook = (config: { root: string }) => Promise<void>

const tempDirs: string[] = []
const message: EmailMessage = { from: "team@example.com", subject: "Join the team", text: "https://example.com/invite/1", to: ["ada@example.com", { email: "bob@example.com", name: "Bob" }] }

afterEach(async () => {
  vi.restoreAllMocks()
  vi.resetModules()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.email.outbox"))
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.email.definition"))
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function generatedDefinition(options: Parameters<typeof hubEmail>[0], command: "build" | "serve", hosting = "node"): Promise<{ code: string, definition?: EmailDefinition & { canSend?: boolean } }> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-email-log-"))
  tempDirs.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
  const plugin = hubEmail({ ...options, hosting } as Parameters<typeof hubEmail>[0])
  // SAFETY: the hooks are functions in hubEmail. The test calls them the way Vite does.
  await (plugin.config as ConfigHook)({ root }, { command, mode: command === "serve" ? "development" : "production" })
  await (plugin.configResolved as ConfigResolvedHook)({ root })
  const handler = plugin.api.getDefinition()!.handler
  const code = await readFile(handler, "utf8")
  if (hosting === "cloudflare") return { code }
  const module: { definition: EmailDefinition & { canSend?: boolean } } = await import(`${pathToFileURL(handler).href}?${command}`)
  return { code, definition: module.definition }
}

describe("log Email driver", () => {
  it("prints the recipients, subject, and body and sends nothing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, "fetch")

    const [error, sent] = await createEmail({ driver: logEmailDriver() }).send(message)

    expect(error).toBeUndefined()
    expect(sent).toMatchObject({ driver: "log", id: expect.stringMatching(/^log-/) })
    expect(info).toHaveBeenCalledWith("[vitehub] Email log driver. Not sent to ada@example.com, \"Bob\" <bob@example.com>: Join the team\nhttps://example.com/invite/1")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("prints the HTML body when the message has no text", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    await createEmail({ driver: logEmailDriver() }).send({ from: "team@example.com", html: "<p>Hi</p>", subject: "Hi", to: "ada@example.com" })
    expect(info.mock.calls[0]![0]).toMatch(/\n<p>Hi<\/p>$/)
  })

  it.each(["node", "cloudflare", "vercel"])("builds for %s without options and marks the definition as not able to send", async (hosting) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const { code, definition } = await generatedDefinition({ driver: "log" }, "build", hosting)

    expect(code).not.toContain("send_email")
    expect(code).not.toContain("api.resend.com")
    expect(code).toMatch(/canSend: ?(false|!1)/)
    if (hosting === "cloudflare") return
    expect(definition?.canSend).toBe(false)
    if (hosting === "node") {
      await expect(createEmail(definition!).send(message)).resolves.toMatchObject([undefined, { driver: "log" }])
      expect(info).toHaveBeenCalledOnce()
    }
  })

  it("marks provider definitions as able to send", async () => {
    const { definition } = await generatedDefinition({ driver: "resend", options: { apiKey: "re_test" } }, "build")
    expect(definition?.canSend).toBe(true)
  })

  it("runs in vite dev with outbox: false and no remote, and prints no remote notice", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { definition } = await generatedDefinition({ driver: "log", outbox: false }, "serve")

    await expect(createEmail(definition!).send(message)).resolves.toMatchObject([undefined, { driver: "log" }])
    expect(info).toHaveBeenCalledOnce()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("email.canSend", () => {
  it("is false without an Email definition", async () => {
    vi.doMock("#vitehub/email/definition", () => ({ default: undefined }))
    const { email } = await import("../src/index.ts")
    expect(email.canSend).toBe(false)
  })

  it("is false with the log driver and true with a provider", async () => {
    vi.doMock("#vitehub/email/definition", () => ({ default: { canSend: false, driver: logEmailDriver() } }))
    expect((await import("../src/index.ts")).email.canSend).toBe(false)
    vi.resetModules()
    vi.doMock("#vitehub/email/definition", () => ({ default: { canSend: true, driver: logEmailDriver() } }))
    expect((await import("../src/index.ts")).email.canSend).toBe(true)
  })

  it("is true for a definition without the flag, such as a custom driver", async () => {
    vi.doMock("#vitehub/email/definition", () => ({ default: undefined }))
    const { email } = await import("../src/index.ts")
    Reflect.set(globalThis, Symbol.for("vitehub.email.definition"), { driver: logEmailDriver() })
    expect(email.canSend).toBe(true)
  })
})
