import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { afterEach, expect, it, vi } from "vitest"
import vue from "@vitejs/plugin-vue"
import { createServer, resolveConfig } from "vite"

import { VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite"

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

it("types Vue props without promising that a component renders a subject", async () => {
  const root = await createProject({ vue: true })
  const emails = join(root, "server/emails")
  await writeFile(join(emails, "conditional.vue"), '<script setup lang="ts">import { EmailSubject } from "@vite-hub/email/vue"; defineProps<{ enabled: boolean }>()</script><template><EmailSubject v-if="enabled">Conditional</EmailSubject></template>')
  await writeFile(join(emails, "commented.vue"), '<template><!-- <EmailSubject>Comment</EmailSubject> --><p>Body</p></template>')
  await writeFile(join(emails, "partial.vue"), '<script setup>import Subject from "./_subject.vue"</script><template><Subject /></template>')
  await writeFile(join(emails, "_subject.vue"), '<script setup>import { EmailSubject } from "@vite-hub/email/vue"</script><template><EmailSubject>Partial</EmailSubject></template>')
  await configure(root, [hostVuePlugin])

  const registry = await readFile(join(root, ".vitehub", "types", "email-templates.d.ts"), "utf8")
  const props = (file: string) => `Omit<InstanceType<typeof import("../../server/emails/${file}").default>["$props"], keyof import("vue").AllowedComponentProps | keyof import("vue").VNodeProps>`
  for (const name of ["invite", "auth/reset", "conditional", "commented", "partial"]) {
    expect(registry).toContain(`"${name}": {\n      data: ${props(`${name}.vue`)}\n      subject: false\n    }`)
  }
  expect(registry).not.toContain("_layout")
  const modules = await readFile(join(root, ".vitehub", "types", "email.d.ts"), "utf8")
  expect(modules.match(/subject\?: string/g)).toHaveLength(5)
  const render = async (name: string) => (await import(pathToFileURL(join(root, ".vitehub/email/templates", `${name}.mjs`)).href)).default({ enabled: false })
  expect((await render("conditional")).subject).toBeUndefined()
  expect((await render("commented")).subject).toBeUndefined()
  expect((await render("partial")).subject).toBe("Partial")
})

it("defers Cloudflare Nuxt replay until TypeScript project references exist", async () => {
  const root = await createProject({ vue: true })
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "./.nuxt/tsconfig.app.json" }] }))
  const plugin = hubEmail({ driver: "log" })
  const config = { [VITEHUB_NITRO_CONFIG_CONTEXT]: true, nitro: { preset: "cloudflare-module" }, root }
  const renderer = join(root, ".vitehub/email/templates/invite.mjs")

  await (plugin.config as ConfigHook)(config, { command: "build", mode: "production" })
  await (plugin.configResolved as ConfigResolvedHook)({ ...config, plugins: [] })
  await expect(readFile(renderer, "utf8")).rejects.toMatchObject({ code: "ENOENT" })

  await mkdir(join(root, ".nuxt"))
  await writeFile(join(root, ".nuxt/tsconfig.app.json"), JSON.stringify({ compilerOptions: { target: "ESNext" }, include: ["../**/*"] }))
  await plugin.api.prepareTypes({ materialize: true, projectRoot: root })
  const { default: render } = await import(pathToFileURL(renderer).href)
  await expect(render({ name: "Ada", team: "Docs" })).resolves.toMatchObject({ subject: "Join Docs" })
})

it("shares hosted Vite aliases and Vue compiler settings with CLI preview", async () => {
  const root = await createProject({ vue: true })
  const emails = join(root, "server/emails")
  const invite = join(emails, "invite.vue")
  await writeFile(invite, (await readFile(invite, "utf8")).replaceAll("{{", "[[").replaceAll("}}", "]]").replace('"./_layout.vue"', '"@mail/_layout.vue"'))
  const plugin = hubEmail({ driver: "log" })
  const inlineConfig = {
    configFile: false,
    plugins: [plugin, vue({ template: { compilerOptions: { delimiters: ["[[", "]]"] } } })],
    resolve: { alias: { "@mail": emails } },
    root,
    nitro: { preset: "vercel" },
  } satisfies import("vite").InlineConfig & { nitro: { preset: string } }
  const config = await resolveConfig(inlineConfig, "build")
  expect(config.resolve.alias).toContainEqual({ find: "@mail", replacement: emails })
  const { default: render } = await import(pathToFileURL(join(root, ".vitehub/email/templates/invite.mjs")).href)
  const data = { name: "Ada", team: "Docs" }
  const rendered = await render(data)
  expect(rendered).toMatchObject({ subject: "Join Docs", html: expect.stringContaining("<h1>Hi Ada</h1>") })
  const cli = await plugin.vitehub.cli?.()
  const preview = cli?.namespaces[0]?.features.find(feature => feature.name === "preview")
  const write = vi.fn()
  const context = { cwd: root, rootDir: root, env: {}, spawn: vi.fn(), stderr: { write: vi.fn() }, stdout: { write } }
  await expect(preview?.run(["invite", "--json", "--data", JSON.stringify(data)], context)).resolves.toBe(0)
  expect(JSON.parse(write.mock.calls[0]![0])).toMatchObject(rendered)
})

it("materializes the first Vue template added to the running Markdown app", async () => {
  const root = await createProject({ vue: true })
  const emails = join(root, "server/emails")
  await Promise.all([rm(join(emails, "invite.vue")), rm(join(emails, "auth"), { recursive: true })])
  const server = await createServer({ configFile: false, plugins: [hubEmail({ driver: "log" }), vue()], root, server: { middlewareMode: true } })
  try {
    const template = join(emails, "new.vue")
    await vi.waitFor(() => expect(server.watcher.getWatched()[emails]).toContain("welcome.md"))
    await writeFile(template, "<template><p>New email</p></template>")
    await vi.waitFor(async () => {
      const registry = await readFile(join(root, ".vitehub/email/preview.mjs"), "utf8")
      expect(registry).toContain('"new": () => import("./templates/new.mjs")')
      const { default: render } = await import(pathToFileURL(join(root, ".vitehub/email/templates/new.mjs")).href)
      await expect(render({})).resolves.toMatchObject({ text: "New email" })
    })
  }
  finally {
    await server.close()
  }
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
