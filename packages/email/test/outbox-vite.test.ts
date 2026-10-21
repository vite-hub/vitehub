import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { afterEach, describe, expect, it } from "vitest"

import { createEmail } from "../src/client.ts"
import { emailDevHeader, emailDevHeaderValue } from "../src/dev.ts"
import { clearEmailOutbox, getEmailOutboxMessage, listEmailOutbox, handleEmailDevRequest, readEmailOutboxConsoleRecords } from "../src/runtime/console.ts"
import { getEmailOutbox } from "../src/runtime/outbox.ts"
import { hubEmail } from "../src/vite.ts"

import type { EmailClient, EmailDefinition } from "../src/types.ts"

type ConfigHook = (config: Record<string, unknown>, env?: { command: "build" | "serve", mode: string }) => Promise<unknown>
type ConfigResolvedHook = (config: { root: string }) => Promise<void>

const tempDirs: string[] = []
const outboxState = Symbol.for("vitehub.email.outbox")

afterEach(async () => {
  Reflect.deleteProperty(globalThis, outboxState)
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

const devHandler = (root: string) => join(root, ".vitehub", "nitro", "email", "dev-handler.ts")

describe("Email development outbox output", () => {
  it("exposes the configured runtime identity through the public server export", async () => {
    const root = await createTempProject()
    const { definition } = await configure(hubEmail({ driver: "resend", outbox: { deliver: false } }), root, "serve")
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
    const plugin = hubEmail({ driver: "resend", outbox: { deliver: false } })
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

  it("never adds the outbox or its handler to build output", async () => {
    for (const command of ["build", undefined] as const) {
      const root = await createTempProject()
      const { config, definition } = await configure(hubEmail({ driver: "resend", outbox: { deliver: false } }), root, command)

      const source = await readFile(definition, "utf8")
      expect(source).toContain("https://api.resend.com")
      expect(source).not.toContain("createEmailDevOutboxDriver")
      expect(source).not.toContain("vitehub.email.outbox")
      expect(JSON.stringify(config.nitro)).not.toContain("dev-handler")
      await expect(stat(devHandler(root))).rejects.toMatchObject({ code: "ENOENT" })
    }
  })

  it("wraps the provider driver and adds the guarded handler in vite dev", async () => {
    const root = await createTempProject()
    const { config, definition } = await configure(hubEmail({ driver: "resend", outbox: { deliver: false, limit: 3 } }), root, "serve")

    const source = await readFile(definition, "utf8")
    expect(source).toContain("vitehub.email.outbox")
    expect(config.nitro).toMatchObject({
      baseURL: "/app/",
      handlers: [{ handler: devHandler(root), route: "/_vitehub/email/dev" }],
    })
    expect(await readFile(devHandler(root), "utf8"))
      .toContain("import { handleEmailDevRequest as handleViteHubDevRequest } from \"@vite-hub/email/runtime/console\"")

    // The generated definition is a separate bundle. It must write to the outbox that the Console reader reads.
    const module: { definition: EmailDefinition, outboxRuntimeId: string } = await import(pathToFileURL(definition).href)
    expect(await readFile(devHandler(root), "utf8")).toContain(JSON.stringify(module.outboxRuntimeId))
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

  it("gives separate applications and restarts fresh outbox identities", async () => {
    const firstRoot = await createTempProject()
    const secondRoot = await createTempProject()
    const firstPlugin = hubEmail({ driver: "resend", outbox: { deliver: false } })
    const first = await configure(firstPlugin, firstRoot, "serve")
    const firstModule: { definition: EmailDefinition, outboxRuntimeId: string } = await import(pathToFileURL(first.definition).href)
    await createEmail(firstModule.definition).send({ from: "hello@example.com", subject: "First app", text: "Hi", to: "ada@example.com" })
    const second = await configure(hubEmail({ driver: "resend", outbox: { deliver: false } }), secondRoot, "serve")
    const secondModule: { definition: EmailDefinition, outboxRuntimeId: string } = await import(pathToFileURL(second.definition).href)
    expect(secondModule.outboxRuntimeId).not.toBe(firstModule.outboxRuntimeId)
    expect(getEmailOutbox(secondModule.outboxRuntimeId)).toBeUndefined()
    await createEmail(secondModule.definition).send({ from: "hello@example.com", subject: "Second app", text: "Hi", to: "ada@example.com" })
    const clear = await handleEmailDevRequest(new Request("http://localhost/_vitehub/email/dev", { body: JSON.stringify({ operation: "clear" }), headers: { "content-type": "application/json", [emailDevHeader]: emailDevHeaderValue }, method: "POST" }), secondModule.outboxRuntimeId)
    expect(await clear.json()).toEqual({ cleared: 1 })
    expect(readEmailOutboxConsoleRecords(firstModule.outboxRuntimeId)).toHaveLength(1)
    expect(getEmailOutbox(firstModule.outboxRuntimeId)?.list()).toHaveLength(1)
    await createEmail(secondModule.definition).send({ from: "hello@example.com", subject: "Retained second app", text: "Hi", to: "ada@example.com" })
    const close = firstPlugin.closeBundle
    if (!(close instanceof Function)) throw new Error("Expected an Email teardown hook")
    await Reflect.apply(close, undefined, [])
    expect(getEmailOutbox(firstModule.outboxRuntimeId)).toBeUndefined()
    expect(getEmailOutbox(secondModule.outboxRuntimeId)?.list()).toHaveLength(1)
    const restarted = await configure(hubEmail({ driver: "resend", outbox: { deliver: false } }), firstRoot, "serve")
    const restartedModule: { outboxRuntimeId: string } = await import(`${pathToFileURL(restarted.definition).href}?restart`)
    expect(restartedModule.outboxRuntimeId).not.toBe(firstModule.outboxRuntimeId)
    expect(getEmailOutbox(restartedModule.outboxRuntimeId)).toBeUndefined()
  })

  it("delivers through the provider by default in vite dev", async () => {
    const root = await createTempProject()
    const { definition } = await configure(hubEmail({ driver: "resend" }), root, "serve")

    expect(await readFile(definition, "utf8")).toContain("vitehub.email.outbox")
    const module: { definition: EmailDefinition, outboxRuntimeId: string } = await import(pathToFileURL(definition).href)
    // No API key is configured, so the provider driver fails. The outbox keeps the message and the failure.
    await expect(createEmail(module.definition).send({ from: "hello@example.com", subject: "Hi", text: "Hi", to: "ada@example.com" }))
      .rejects.toMatchObject({ code: "EMAIL_NOT_CONFIGURED" })
    expect(getEmailOutbox(module.outboxRuntimeId)?.list()[0]).toMatchObject({ delivery: { status: "failed" }, provider: "resend", subject: "Hi" })
  })

  it("keeps the handler but reports a disabled outbox with outbox: false", async () => {
    const root = await createTempProject()
    const { definition } = await configure(hubEmail({ driver: "resend", outbox: false }), root, "serve")

    expect(await readFile(definition, "utf8")).not.toContain("vitehub.email.outbox")
    expect(await readFile(devHandler(root), "utf8")).toContain("handleDisabledEmailDevRequest")
  })

  it("rejects invalid outbox options", () => {
    // SAFETY: the casts pass invalid runtime values that JavaScript callers can send.
    expect(() => hubEmail({ driver: "resend", outbox: true as unknown as false })).toThrow("`email.outbox` must be `false` or an object.")
    expect(() => hubEmail({ driver: "resend", outbox: { deliver: "yes" as unknown as boolean } })).toThrow("`email.outbox.deliver` must be a boolean.")
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
