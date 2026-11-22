import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { afterEach, expect, it } from "vitest"

import { getEmailOutboxMessage, listEmailOutbox } from "../src/runtime/console.ts"
import { hubEmail } from "../src/vite.ts"

import type { EmailClient, EmailSendMessage } from "../src/types.ts"

type ConfigHook = (config: Record<string, unknown>, env?: { command: "build" | "serve", mode: string }) => Promise<unknown>
type ConfigResolvedHook = (config: { root: string }) => Promise<void>

const tempDirs: string[] = []

afterEach(async () => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.email.outbox"))
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.email.devCapture"))
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

const envelope = { from: "hello@example.com", subject: "Welcome", to: "ada@example.com" }

async function loadDevEmail(): Promise<{ email: EmailClient<EmailSendMessage>, emailOutboxRuntimeId: string }> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-email-template-send-"))
  tempDirs.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
  await mkdir(join(root, "server", "emails"), { recursive: true })
  await writeFile(join(root, "server", "emails", "welcome.md"), [
    "# Welcome {{ data.user.name }}",
    "",
    "::if{:condition=\"data.trial\"}",
    "Your trial is active.",
    "::",
    "",
  ].join("\n"))
  const plugin = hubEmail({ driver: "resend" })
  // SAFETY: the hooks are functions in hubEmail. The test calls them the way Vite does.
  await (plugin.config as ConfigHook)({ root }, { command: "serve", mode: "development" })
  await (plugin.configResolved as ConfigResolvedHook)({ root })
  const definition = plugin.api.getDefinition()?.handler
  expect(definition).toBeTypeOf("string")
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir")
  const file = join(root, "email-server.mjs")
  await build({
    bundle: true,
    entryPoints: [resolve("src/index.ts")],
    format: "esm",
    outfile: file,
    packages: "external",
    platform: "node",
    plugins: [{
      name: "generated-email-definition",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^#vitehub\/email\/definition$/ }, () => ({ path: definition! }))
      },
    }],
  })
  return await import(pathToFileURL(file).href)
}

it("renders a template with its data and sends it through the dev outbox", async () => {
  const { email, emailOutboxRuntimeId } = await loadDevEmail()

  const [error, sent] = await email.send({ ...envelope, template: "welcome", data: { trial: true, user: { name: "Ada" } } })

  expect(error).toBeUndefined()
  expect(sent).toEqual({ driver: "outbox", id: "outbox-1" })
  const message = getEmailOutboxMessage("outbox-1", emailOutboxRuntimeId)
  expect(message).toMatchObject({ subject: "Welcome", to: ["ada@example.com"] })
  expect(message?.text).toBe("# Welcome Ada\n\nYour trial is active.")
  expect(message?.html).toContain("Welcome Ada</h1>")
  expect(message?.html).toContain("<p>Your trial is active.</p>")
})

it("returns EMAIL_TEMPLATE_RENDER_FAILED when the data does not fit the template", async () => {
  const { email, emailOutboxRuntimeId } = await loadDevEmail()

  // @ts-expect-error An untyped caller can omit `data` that the template reads.
  const [error, sent] = await email.send({ ...envelope, template: "welcome" })

  expect(sent).toBeUndefined()
  expect(error).toMatchObject({ code: "EMAIL_TEMPLATE_RENDER_FAILED", cause: { code: "MARKDOWN_TEMPLATE_R0017" } })
  expect(error?.fix).toContain("{{ data.* }}")
  expect(listEmailOutbox(emailOutboxRuntimeId).messages).toEqual([])
})

it("throws EMAIL_TEMPLATE_NOT_FOUND for a name that no template has", async () => {
  const { email } = await loadDevEmail()

  // @ts-expect-error An untyped caller can pass any name.
  await expect(email.send({ ...envelope, template: "missing" })).rejects.toMatchObject({
    code: "EMAIL_TEMPLATE_NOT_FOUND",
    message: expect.stringContaining("Templates: welcome."),
  })
})

it("still sends a message with a body", async () => {
  const { email, emailOutboxRuntimeId } = await loadDevEmail()

  await expect(email.send({ ...envelope, text: "Hello" })).resolves.toEqual([undefined, { driver: "outbox", id: "outbox-1" }])
  expect(getEmailOutboxMessage("outbox-1", emailOutboxRuntimeId)?.text).toBe("Hello")
})
