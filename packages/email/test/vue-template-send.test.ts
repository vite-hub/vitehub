import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { afterEach, expect, it } from "vitest"

import { getEmailOutboxMessage, listEmailOutbox } from "../src/runtime/console.ts"
import { hubEmail } from "../src/vite.ts"

import type { Plugin } from "vite"
import type { EmailClient, EmailSendMessage } from "../src/types.ts"

type ConfigHook = (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
type ConfigResolvedHook = (config: { plugins: readonly Plugin[], root: string }) => Promise<void>
type UntypedSend = (message: Record<string, unknown>) => ReturnType<EmailClient<EmailSendMessage>["send"]>

const tempDirs: string[] = []
const hostVuePlugin: Plugin = { name: "vite:vue", api: { options: { isProduction: true } } }

afterEach(async () => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.email.outbox"))
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.email.devCapture"))
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

// SAFETY: these tests send templates of their own temp project, which the typed registry of this package does not list.
const untyped = (email: EmailClient<EmailSendMessage>) => email.send as UntypedSend

const envelope = { from: "hello@example.com", to: "ada@example.com" }

async function packageNames(): Promise<string[]> {
  const names = await Promise.all((await readdir(resolve("node_modules"))).filter(name => !name.startsWith(".")).map(async name =>
    name.startsWith("@") ? (await readdir(resolve("node_modules", name))).map(child => `${name}/${child}`) : [name]))
  return names.flat()
}

async function createProject(options: { vue: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-email-vue-"))
  tempDirs.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
  const names = options.vue ? await packageNames() : (await packageNames()).filter(name => name !== "vue" && !name.startsWith("@vue/"))
  for (const name of names) {
    await mkdir(join(root, "node_modules", name, ".."), { recursive: true })
    await symlink(resolve("node_modules", name), join(root, "node_modules", name), "dir")
  }
  await symlink(resolve("."), join(root, "node_modules", "@vite-hub", "email"), "dir")
  const emails = join(root, "server", "emails")
  await mkdir(join(emails, "_parts"), { recursive: true })
  await writeFile(join(emails, "invite.vue"), [
    "<script setup lang=\"ts\">",
    "import { EmailSubject } from \"@vite-hub/email/vue\"",
    "import Layout from \"./_layout.vue\"",
    "defineProps<{ name: string, team: string, trial?: boolean }>()",
    "</script>",
    "",
    "<template>",
    "  <Layout>",
    "    <EmailSubject>Join {{ team }}</EmailSubject>",
    "    <h1>Hi {{ name }}</h1>",
    "    <p>Join <strong>{{ team }}</strong> &amp; build.</p>",
    "    <p v-if=\"trial\">Your trial is active.</p>",
    "  </Layout>",
    "</template>",
    "",
  ].join("\n"))
  await writeFile(join(emails, "_layout.vue"), [
    "<script setup lang=\"ts\">",
    "import Footer from \"./_parts/footer.vue\"",
    "</script>",
    "",
    "<template>",
    "  <table role=\"presentation\"><tbody><tr><td><slot /></td></tr></tbody></table>",
    "  <Footer />",
    "</template>",
    "",
  ].join("\n"))
  await writeFile(join(emails, "_parts", "footer.vue"), "<template><div style=\"color: gray\">Sent by <span>Acme</span></div></template>\n")
  await mkdir(join(emails, "auth"), { recursive: true })
  await writeFile(join(emails, "auth", "reset.vue"), [
    "<script setup lang=\"ts\">",
    "import Layout from \"../_layout.vue\"",
    "defineProps<{ link: string }>()",
    "</script>",
    "",
    "<template><Layout><p><a :href=\"link\">Reset your password</a></p></Layout></template>",
    "",
  ].join("\n"))
  await writeFile(join(emails, "welcome.md"), "---\nsubject: Welcome\n---\n\n# Welcome {{ data.name }}\n")
  return root
}

async function configure(root: string, plugins: Plugin[]) {
  const plugin = hubEmail({ driver: "resend" })
  // SAFETY: the hooks are functions in hubEmail. The test calls them the way Vite does.
  await (plugin.config as ConfigHook)({ root }, { command: "serve", mode: "development" })
  await (plugin.configResolved as ConfigResolvedHook)({ plugins, root })
  return plugin
}

async function loadDevEmail(): Promise<{ email: EmailClient<EmailSendMessage>, emailOutboxRuntimeId: string }> {
  const root = await createProject({ vue: true })
  const definition = (await configure(root, [hostVuePlugin])).api.getDefinition()?.handler
  expect(definition).toBeTypeOf("string")
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

it("renders a Vue template with its props, layout partial, and subject, and sends it through the dev outbox", async () => {
  const { email, emailOutboxRuntimeId } = await loadDevEmail()

  const [error, sent] = await untyped(email)({ ...envelope, template: "invite", data: { name: "Ada", team: "Docs", trial: true } })

  expect(error).toBeUndefined()
  expect(sent).toEqual({ driver: "outbox", id: "outbox-1" })
  const message = getEmailOutboxMessage("outbox-1", emailOutboxRuntimeId)
  expect(message).toMatchObject({ subject: "Join Docs", to: ["ada@example.com"] })
  expect(message?.html).toContain("<h1>Hi Ada</h1>")
  expect(message?.html).toContain("<p>Join <strong>Docs</strong> &amp; build.</p>")
  expect(message?.html).toContain("Sent by <span>Acme</span>")
  expect(message?.html).not.toMatch(/<!--/)
  expect(message?.text).toBe("# Hi Ada\n\nJoin **Docs** & build.\n\nYour trial is active.\n\nSent by Acme")
})

it("lets the subject of the message win over `<EmailSubject>`, and renders `v-if` branches that are off", async () => {
  const { email, emailOutboxRuntimeId } = await loadDevEmail()

  await untyped(email)({ ...envelope, subject: "Custom", template: "invite", data: { name: "Ada", team: "Docs" } })

  const message = getEmailOutboxMessage("outbox-1", emailOutboxRuntimeId)
  expect(message?.subject).toBe("Custom")
  expect(message?.text).toBe("# Hi Ada\n\nJoin **Docs** & build.\n\nSent by Acme")
})

it("sends Markdown and Vue templates from the same folder, and leaves `_` Vue files out", async () => {
  const { email, emailOutboxRuntimeId } = await loadDevEmail()

  await untyped(email)({ ...envelope, template: "welcome", data: { name: "Ada" } })
  await expect(untyped(email)({ ...envelope, subject: "Layout", template: "_layout" })).rejects.toMatchObject({ code: "EMAIL_TEMPLATE_NOT_FOUND" })

  expect(getEmailOutboxMessage("outbox-1", emailOutboxRuntimeId)).toMatchObject({ subject: "Welcome", text: "# Welcome Ada" })
  expect(listEmailOutbox(emailOutboxRuntimeId).messages).toHaveLength(1)
})

it("sends a Vue template from a subfolder by its path", async () => {
  const { email, emailOutboxRuntimeId } = await loadDevEmail()

  const [error] = await untyped(email)({ ...envelope, subject: "Reset", template: "auth/reset", data: { link: "https://example.com/reset?token=1&next=2" } })

  expect(error).toBeUndefined()
  const message = getEmailOutboxMessage("outbox-1", emailOutboxRuntimeId)
  expect(message?.html).toContain("<a href=\"https://example.com/reset?token=1&amp;next=2\">Reset your password</a>")
  expect(message?.text).toBe("[Reset your password](https://example.com/reset?token=1&next=2)\n\nSent by Acme")
})

it("types the data of a Vue template from its props, and its subject from `<EmailSubject>`", async () => {
  const root = await createProject({ vue: true })
  await configure(root, [hostVuePlugin])

  const registry = await readFile(join(root, ".vitehub", "types", "email-templates.d.ts"), "utf8")
  const props = (file: string) => `Omit<InstanceType<typeof import("../../server/emails/${file}").default>["$props"], keyof import("vue").AllowedComponentProps | keyof import("vue").VNodeProps>`
  expect(registry).toContain(`"invite": {\n      data: ${props("invite.vue")}\n      subject: true\n    }`)
  expect(registry).toContain(`"auth/reset": {\n      data: ${props("auth/reset.vue")}\n      subject: false\n    }`)
  expect(registry).not.toContain("_layout")
})

it("throws EMAIL_VUE_PLUGIN_MISSING when the Vite config has no `@vitejs/plugin-vue`", async () => {
  const root = await createProject({ vue: true })

  await expect(configure(root, [])).rejects.toMatchObject({
    code: "EMAIL_VUE_PLUGIN_MISSING",
    message: expect.stringMatching(/server\/emails\/.+\.vue/),
  })
})

it("throws EMAIL_VUE_MISSING when the app cannot import `vue`", async () => {
  const root = await createProject({ vue: false })

  await expect(configure(root, [hostVuePlugin])).rejects.toMatchObject({ code: "EMAIL_VUE_MISSING" })
})
