import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createEmail } from "../src/client.ts"
import { clearEmailOutbox, getEmailOutboxMessage, listEmailOutbox, readEmailOutboxConsoleRecords } from "../src/runtime/console.ts"
import { clearEmailOutboxMessages, listEmailOutboxMessages } from "../src/runtime/operations.ts"
import { getEmailOutbox } from "../src/runtime/outbox.ts"
import { hubEmail } from "../src/vite.ts"

import type { EmailClient, EmailDefinition } from "../src/types.ts"

type ConfigHook = (config: Record<string, unknown>, env?: { command: "build" | "serve", mode: string }) => Promise<unknown>
type ConfigResolvedHook = (config: { root: string }) => Promise<void>

const tempDirs: string[] = []
const outboxState = Symbol.for("vitehub.email.outbox")
const captureState = Symbol.for("vitehub.email.devCapture")

afterEach(async () => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, outboxState)
  Reflect.deleteProperty(globalThis, captureState)
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-email-outbox-"))
  tempDirs.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
  return root
}

async function configure(plugin: ReturnType<typeof hubEmail>, root: string, command?: "build" | "serve"): Promise<{ config: Record<string, unknown>, definition: string }> {
  const config: Record<string, unknown> = { nitro: { baseURL: "/app/" }, root }
  // SAFETY: the hooks are functions in hubEmail. The tests call them the way Vite does.
  await (plugin.config as ConfigHook)(config, command ? { command, mode: command === "serve" ? "development" : "production" } : undefined)
  await (plugin.configResolved as ConfigResolvedHook)({ root })
  const handler = plugin.api.getDefinition()?.handler
  if (!handler) throw new Error("Expected a configured Email definition")
  return { config, definition: handler }
}

describe("Email development outbox output", () => {
  it("exposes the configured runtime identity through the public server export", async () => {
    const root = await createTempProject()
    const { definition } = await configure(hubEmail({ driver: "resend" }), root, "serve")
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir")
    const file = join(root, "public-email-server.mjs")
    await build({
      bundle: true,
      entryPoints: [resolve("src/server.ts")],
      format: "esm",
      outfile: file,
      packages: "external",
      platform: "node",
      plugins: [{
        name: "generated-email-definition",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^#vitehub\/email\/definition$/ }, () => ({ path: definition }))
        },
      }],
    })
    const server: { email: EmailClient, emailOutboxRuntimeId: string } = await import(pathToFileURL(file).href)
    await server.email.send({ from: "hello@example.com", subject: "Public reader", to: "ada@example.com" })
    const messages = listEmailOutbox(server.emailOutboxRuntimeId).messages
    expect(messages).toHaveLength(1)
    expect(getEmailOutboxMessage(messages[0]!.id, server.emailOutboxRuntimeId)?.subject).toBe("Public reader")
    expect(clearEmailOutbox(server.emailOutboxRuntimeId)).toBe(1)
    expect(listEmailOutbox(server.emailOutboxRuntimeId).messages).toEqual([])
  })

  it("re-exports the runtime identity through the Vite virtual definition", async () => {
    const root = await createTempProject()
    const plugin = hubEmail({ driver: "resend" })
    const { definition } = await configure(plugin, root, "serve")
    const load = plugin.load
    if (!(load instanceof Function)) throw new Error("Expected the Email load hook")
    const virtual: unknown = await Reflect.apply(load, undefined, ["\0#vitehub/email/definition"])
    if (typeof virtual !== "string") throw new Error("Expected the virtual definition source")
    const file = join(root, "virtual-email.mjs")
    await writeFile(file, virtual)
    const generated: { outboxRuntimeId: string } = await import(pathToFileURL(definition).href)
    const resolved: { outboxRuntimeId: string } = await import(pathToFileURL(file).href)
    expect(resolved.outboxRuntimeId).toBe(generated.outboxRuntimeId)
  })

  it("never adds the outbox to build output", async () => {
    for (const command of ["build", undefined] as const) {
      const root = await createTempProject()
      const { config, definition } = await configure(hubEmail({ driver: "resend" }), root, command)

      const source = await readFile(definition, "utf8")
      expect(source).toContain("https://api.resend.com")
      expect(source).not.toContain("createEmailDevOutboxDriver")
      expect(source).not.toContain("vitehub.email.outbox")
      await import(pathToFileURL(definition).href)
      expect(Reflect.get(globalThis, captureState)).toBe(false)
      expect(JSON.stringify(config.nitro)).not.toContain("email/dev")
    }
  })

  it("wraps the provider driver in vite dev", async () => {
    const root = await createTempProject()
    const { config, definition } = await configure(hubEmail({ driver: "resend", outbox: { limit: 3 } }), root, "serve")

    const source = await readFile(definition, "utf8")
    expect(source).toContain("vitehub.email.outbox")
    // The operations carry the outbox, so the plugin adds no Nitro route or handler.
    expect(config.nitro).toEqual({ baseURL: "/app/", modules: expect.any(Array) })

    // The generated definition is a separate bundle. It must write to the outbox that the Console reader reads.
    const module: { definition: EmailDefinition, outboxRuntimeId: string } = await import(pathToFileURL(definition).href)
    const email = createEmail(module.definition)
    for (const subject of ["One", "Two", "Three", "Four"]) {
      await expect(email.send({ from: "hello@example.com", html: "<p>Hi</p>", subject, to: "ada@example.com" }))
        .resolves.toMatchObject([undefined, { driver: "outbox" }])
    }
    const outbox = getEmailOutbox(module.outboxRuntimeId)
    expect(outbox?.limit).toBe(3)
    expect(outbox?.list().map(message => [message.subject, message.provider, message.delivery.status])).toEqual([
      ["Four", "resend", "captured"],
      ["Three", "resend", "captured"],
      ["Two", "resend", "captured"],
    ])
  })

  it("reads the generated outbox from the Console reader and the operations, which know no runtime id", async () => {
    const root = await createTempProject()
    const { definition } = await configure(hubEmail({ driver: "resend" }), root, "serve")
    const module: { definition: EmailDefinition, outboxRuntimeId: string } = await import(pathToFileURL(definition).href)
    expect(module.outboxRuntimeId).not.toBe("default")
    await createEmail(module.definition).send({ from: "hello@example.com", subject: "Seen by both", text: "Hi", to: "ada@example.com" })

    // The Console calls its section reader with no arguments.
    expect(readEmailOutboxConsoleRecords().map(record => record.cells.subject)).toEqual(["Seen by both"])
    expect(listEmailOutboxMessages().messages.map(message => message.subject)).toEqual(["Seen by both"])
  })

  it("gives separate applications and restarts fresh outbox identities", async () => {
    const firstRoot = await createTempProject()
    const secondRoot = await createTempProject()
    const firstPlugin = hubEmail({ driver: "resend" })
    const first = await configure(firstPlugin, firstRoot, "serve")
    const firstModule: { definition: EmailDefinition, outboxRuntimeId: string } = await import(pathToFileURL(first.definition).href)
    await createEmail(firstModule.definition).send({ from: "hello@example.com", subject: "First app", text: "Hi", to: "ada@example.com" })
    const second = await configure(hubEmail({ driver: "resend" }), secondRoot, "serve")
    const secondModule: { definition: EmailDefinition, outboxRuntimeId: string } = await import(pathToFileURL(second.definition).href)
    expect(secondModule.outboxRuntimeId).not.toBe(firstModule.outboxRuntimeId)
    expect(getEmailOutbox(secondModule.outboxRuntimeId)).toBeUndefined()
    await createEmail(secondModule.definition).send({ from: "hello@example.com", subject: "Second app", text: "Hi", to: "ada@example.com" })
    // The operations answer for the newest outbox, which is the second application's.
    expect(clearEmailOutboxMessages()).toEqual({ cleared: 1 })
    expect(readEmailOutboxConsoleRecords(firstModule.outboxRuntimeId)).toHaveLength(1)
    expect(getEmailOutbox(firstModule.outboxRuntimeId)?.list()).toHaveLength(1)
    await createEmail(secondModule.definition).send({ from: "hello@example.com", subject: "Retained second app", text: "Hi", to: "ada@example.com" })
    const close = firstPlugin.closeBundle
    if (!(close instanceof Function)) throw new Error("Expected an Email teardown hook")
    await Reflect.apply(close, undefined, [])
    expect(getEmailOutbox(firstModule.outboxRuntimeId)).toBeUndefined()
    expect(getEmailOutbox(secondModule.outboxRuntimeId)?.list()).toHaveLength(1)
    const restarted = await configure(hubEmail({ driver: "resend" }), firstRoot, "serve")
    const restartedModule: { outboxRuntimeId: string } = await import(`${pathToFileURL(restarted.definition).href}?restart`)
    expect(restartedModule.outboxRuntimeId).not.toBe(firstModule.outboxRuntimeId)
    expect(getEmailOutbox(restartedModule.outboxRuntimeId)).toBeUndefined()
  })

  it("keeps a dev send in the outbox without a provider request when remote is not set", async () => {
    const root = await createTempProject()
    // The fake keeps a regression off the network.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ id: "real-send" }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    // A configured Resend key: before `remote`, this dev send reached the Resend API.
    const { definition } = await configure(hubEmail({ driver: "resend", options: { apiKey: "re_test_key" } }), root, "serve")

    const module: { definition: EmailDefinition, outboxRuntimeId: string } = await import(pathToFileURL(definition).href)
    await expect(createEmail(module.definition).send({ from: "hello@example.com", subject: "Signup", text: "Hi", to: "ada@example.com" }))
      .resolves.toMatchObject([undefined, { driver: "outbox", id: "outbox-1" }])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(getEmailOutbox(module.outboxRuntimeId)?.list()[0]).toMatchObject({ delivery: { status: "captured" }, provider: "resend", subject: "Signup" })
  })

  it("sends through the provider with remote: true, records the send, and prints the notice once", async () => {
    const root = await createTempProject()
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ id: "resend-message-id" }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { definition } = await configure(hubEmail({ driver: "resend", options: { apiKey: "re_test_key" }, remote: true }), root, "serve")

    const module: { definition: EmailDefinition, outboxRuntimeId: string } = await import(pathToFileURL(definition).href)
    const email = createEmail(module.definition)
    await expect(email.send({ from: "hello@example.com", subject: "First", text: "Hi", to: "ada@example.com" }))
      .resolves.toMatchObject([undefined, { driver: "resend", id: "resend-message-id" }])
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("https://api.resend.com")
    await email.send({ from: "hello@example.com", subject: "Second", text: "Hi", to: "ada@example.com" })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith("[vitehub] Email is remote: `vite dev` sends real email through resend.")
    expect(getEmailOutbox(module.outboxRuntimeId)?.list().map(message => [message.subject, message.delivery])).toEqual([
      ["Second", { id: "resend-message-id", status: "sent" }],
      ["First", { id: "resend-message-id", status: "sent" }],
    ])
  })

  it("ignores remote in build output", async () => {
    const outputs: string[] = []
    for (const remote of [undefined, true]) {
      const root = await createTempProject()
      const { definition } = await configure(hubEmail({ driver: "resend", ...(remote ? { remote } : {}) }), root, "build")
      outputs.push((await readFile(definition, "utf8")).replace(root, "<root>"))
    }
    expect(outputs[1]).toBe(outputs[0])
    expect(outputs[0]).not.toContain("Email is remote")
  })

  it("tells the operations that the outbox is disabled with outbox: false", async () => {
    const root = await createTempProject()
    const { definition } = await configure(hubEmail({ driver: "resend", outbox: false, remote: true }), root, "serve")

    expect(await readFile(definition, "utf8")).not.toContain("vitehub.email.outbox")
    await import(`${pathToFileURL(definition).href}?disabled`)
    expect(() => listEmailOutboxMessages()).toThrowError(expect.objectContaining({ code: "EMAIL_OUTBOX_DISABLED", status: 409 }))
  })

  it("requires remote: true with outbox: false in vite dev, and not in a build", async () => {
    await expect(configure(hubEmail({ driver: "resend", outbox: false }), await createTempProject(), "serve"))
      .rejects.toMatchObject({ code: "EMAIL_REMOTE_REQUIRED" })
    await expect(configure(hubEmail({ driver: "resend", outbox: false }), await createTempProject(), "build")).resolves.toBeDefined()
  })

  it("rejects an invalid remote value", () => {
    // SAFETY: the cast passes an invalid runtime value that JavaScript callers can send.
    expect(() => hubEmail({ driver: "resend", remote: "true" as unknown as boolean }))
      .toThrow(expect.objectContaining({ code: "EMAIL_INVALID_REMOTE", why: "`email.remote` must be a boolean." }))
  })

  it("rejects invalid outbox options", () => {
    // SAFETY: the casts pass invalid runtime values that JavaScript callers can send.
    expect(() => hubEmail({ driver: "resend", outbox: true as unknown as false })).toThrow("`email.outbox` must be `false` or an object.")
    expect(() => hubEmail({ driver: "resend", outbox: { deliver: true } as unknown as { limit: number } }))
      .toThrow(expect.objectContaining({ code: "EMAIL_INVALID_OUTBOX", why: expect.stringContaining("`email.outbox.deliver` was removed") }))
    expect(() => hubEmail({ driver: "resend", outbox: { limit: 0 } })).toThrow("`email.outbox.limit` must be an integer from 1 to 1000.")
    expect(() => hubEmail({ driver: "resend", outbox: { limit: 1001 } })).toThrow("email.outbox.limit")
    expect(() => hubEmail({ driver: "resend", outbox: { limit: 2.5 } })).toThrow("email.outbox.limit")
  })
})

describe("Email runtime Console entry", () => {
  it("keeps build dependencies out of the published runtime Console entry", async () => {
    const result = await build({
      bundle: true,
      entryPoints: [resolve(import.meta.dirname, "../dist/runtime/console.js")],
      format: "esm",
      metafile: true,
      packages: "external",
      platform: "node",
      write: false,
    })
    const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports.map(entry => entry.path))

    expect(imports).not.toContain("esbuild")
    expect(imports).not.toContain("vite")
    expect(imports).not.toContain("node:fs")
    expect(imports).not.toContain("node:fs/promises")
  })
})
