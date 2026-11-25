import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { afterEach, expect, it } from "vitest"

import { getEmailOutboxMessage, listEmailOutbox } from "../src/runtime/console.ts"
import { hubEmail } from "../src/vite.ts"

import type { EmailClient, EmailSendMessage } from "../src/types.ts"

type ConfigHook = (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
type ConfigResolvedHook = (config: { root: string }) => Promise<void>

const tempDirs: string[] = []

afterEach(async () => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.email.outbox"))
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.email.devCapture"))
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

type UntypedSend = (message: Record<string, unknown>) => ReturnType<EmailClient<EmailSendMessage>["send"]>

// SAFETY: these tests send templates of their own temp project, which the typed registry of this package does not list.
const untyped = (email: EmailClient<EmailSendMessage>) => email.send as UntypedSend

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
  await writeFile(join(root, "server", "emails", "invite.md"), "---\nsubject: Join {{ data.team }}\n---\n\nHi {{ data.name }}, join {{ data.team }}.\n")
  await writeFile(join(root, "server", "emails", "_layout.md"), "Layout {{ data.name }}\n")
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
    message: expect.stringContaining("Templates: invite, welcome."),
  })
})

it("still sends a message with a body", async () => {
  const { email, emailOutboxRuntimeId } = await loadDevEmail()

  await expect(email.send({ ...envelope, text: "Hello" })).resolves.toEqual([undefined, { driver: "outbox", id: "outbox-1" }])
  expect(getEmailOutboxMessage("outbox-1", emailOutboxRuntimeId)?.text).toBe("Hello")
})

it("uses the subject frontmatter of the template unless the message passes one", async () => {
  const { email, emailOutboxRuntimeId } = await loadDevEmail()
  const { subject: _subject, ...withoutSubject } = envelope

  await untyped(email)({ ...withoutSubject, template: "invite", data: { name: "Ada", team: "Docs" } })
  await untyped(email)({ ...envelope, template: "invite", data: { name: "Ada", team: "Docs" } })

  expect(getEmailOutboxMessage("outbox-1", emailOutboxRuntimeId)).toMatchObject({ subject: "Join Docs", text: "Hi Ada, join Docs." })
  expect(getEmailOutboxMessage("outbox-2", emailOutboxRuntimeId)?.subject).toBe("Welcome")
})

it("sends a data value that contains a binding as literal text, once", async () => {
  const { email, emailOutboxRuntimeId } = await loadDevEmail()
  const { subject: _subject, ...withoutSubject } = envelope

  const [error] = await untyped(email)({ ...withoutSubject, template: "invite", data: { name: "{{ data.team }}", secret: "leak", team: "{{ data.secret }}" } })

  expect(error).toBeUndefined()
  const message = getEmailOutboxMessage("outbox-1", emailOutboxRuntimeId)
  expect(message?.subject).toBe("Join {{ data.secret }}")
  expect(message?.text).toBe("Hi {{ data.team }}, join {{ data.secret }}.")
  expect(message?.html).toBe("<p>Hi {{ data.team }}, join {{ data.secret }}.</p>")
  expect(JSON.stringify(message)).not.toContain("leak")
})

it("throws EMAIL_TEMPLATE_SUBJECT_REQUIRED when neither the template nor the message has a subject", async () => {
  const { email, emailOutboxRuntimeId } = await loadDevEmail()
  const { subject: _subject, ...withoutSubject } = envelope

  await expect(untyped(email)({ ...withoutSubject, template: "welcome", data: { user: { name: "Ada" } } })).rejects.toMatchObject({
    code: "EMAIL_TEMPLATE_SUBJECT_REQUIRED",
  })
  expect(listEmailOutbox(emailOutboxRuntimeId).messages).toEqual([])
})

it("leaves `_` files out of the templates that `send()` can name", async () => {
  const { email } = await loadDevEmail()

  // @ts-expect-error An untyped caller can pass any name.
  await expect(email.send({ ...envelope, template: "_layout", data: { name: "Ada" } })).rejects.toMatchObject({
    code: "EMAIL_TEMPLATE_NOT_FOUND",
  })
})
