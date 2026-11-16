import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, formatReport, runCodemod } from "../src/index.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const scratch = fileURLToPath(new URL("../.tmp/resend-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function app(source: string, config = "", dependency = "resend") {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  await mkdir(join(cwd, "server"))
  await writeFile(join(cwd, "server/mail.ts"), source)
  await writeFile(join(cwd, "package.json"), JSON.stringify({ dependencies: { [dependency]: "^1.0.0" } }))
  await writeFile(join(cwd, "nuxt.config.ts"), `export default defineNuxtConfig({ modules: ${dependency === "nuxt-resend" ? '["nuxt-resend"]' : "[]"}, vitehub: { host: "node" }, ${config} })\n`)
  return cwd
}

const message = '{ from: "from@example.com", to: "to@example.com", subject: "Hello", text: "Hi" }'
const sdkSend = `import { Resend } from "resend"\nconst resend = new Resend(process.env.RESEND_API_KEY)\nawait resend.emails.send(${message})\n`

describe("resend binding identity", () => {
  it.each([
    `function other(Resend) { return new Resend("other").emails.send(${message}) }`,
    `{ const Resend = OtherClient; new Resend("other").emails.send(${message}) }`,
    `function other(resend) { return resend.emails.send(${message}) }`,
    `function other({ resend }) { return resend.emails.send(${message}) }`,
    `function other() { if (enabled) { var resend = otherClient } return resend.emails.send(${message}) }`,
    `for (const resend of others) { resend.emails.send(${message}) }`,
    `try { work() } catch (resend) { resend.emails.send(${message}) }`,
    `import { useResend } from "other-mailer"\nuseResend().emails.send(${message})`,
    `import useResend from "other-mailer"\nuseResend().emails.send(${message})`,
    `import * as useResend from "other-mailer"\nuseResend().emails.send(${message})`,
  ])("leaves unrelated bindings unchanged: %s", async (untouched) => {
    const cwd = await app(`${sdkSend}${untouched}\n`)
    const run = await runCodemod("resend", { cwd, dryRun: true })
    const mail = run.result.edits.find(edit => edit.path === "server/mail.ts")?.after
    expect(mail).toContain(untouched)
    expect(mail).toContain(`await email.send(${message})`)
    expect(mail).not.toContain('import { Resend } from "resend"')
    expect(mail).not.toContain("const resend = new Resend")
  })

  it.each([false, true])("resolves helper and destructured client references (imported: %s)", async (imported) => {
    const helper = imported ? "getResend" : "useResend"
    const untouched = `function other(${helper}, emails) { ${helper}().emails.send(${message}); emails.send(${message}) }`
    const source = `${imported ? 'import { useResend as getResend } from "#imports"\n' : ""}const { emails } = ${helper}()\nawait emails.send(${message})\n${untouched}\n`
    const cwd = await app(source, "", "nuxt-resend")
    const run = await runCodemod("resend", { cwd, dryRun: true })
    const mail = run.result.edits.find(edit => edit.path === "server/mail.ts")?.after
    expect(mail).toContain(untouched)
    expect(mail).toContain(`await email.send(${message})`)
    expect(mail).not.toContain("const { emails }")
  })
})

describe("resend dependency retention", () => {
  it.each([
    'const { Resend } = require("resend"); new Resend(process.env.LEGACY_KEY).contacts.list()',
    'const sdk = module.require("resend")',
    'import sdk = require("resend")',
    'const sdk = await import("resend")',
    'import "resend"',
  ])("keeps remaining package loads: %s", async (source) => {
    const cwd = await app(sdkSend)
    await writeFile(join(cwd, "server/legacy.cts"), `${source}\n`)
    const run = await runCodemod("resend", { cwd, dryRun: true })
    const manifest = run.result.edits.find(edit => edit.path === "package.json")?.after
    expect(JSON.parse(manifest!).dependencies).toHaveProperty("resend")
    expect(run.result.edits.some(edit => edit.path === "server/legacy.cts")).toBe(false)
  })
})

it("reports a literal runtimeConfig Resend key that needs manual migration", async () => {
  const cwd = await app(`await useResend().emails.send(${message})`, 'runtimeConfig: { resend: { apiKey: "re_example" } },', "nuxt-resend")
  const run = await runCodemod("resend", { cwd, dryRun: true })
  expect(run.result.followUps).toEqual(expect.arrayContaining([expect.objectContaining({
    file: "nuxt.config.ts",
    message: expect.stringContaining("literal Resend API key"),
  })]))
})

describe("resend runtime config compatibility", () => {
  it.each([
    "const legacy = useRuntimeConfig().resend",
    "const { resend } = useRuntimeConfig()",
    "const {\n  resend\n} = useRuntimeConfig()",
    "const legacy = useRuntimeConfig()[section]",
  ])("keeps module-provided config without relying on reader syntax: %s", async (reader) => {
    const cwd = await app(`await useResend().emails.send(${message})\n${reader}\n`, "", "nuxt-resend")
    const run = await runCodemod("resend", { cwd, dryRun: true })
    const config = run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after
    expect(config).toContain('resend: { apiKey: "" }')
    expect(config).not.toContain('"nuxt-resend"')
  })

  it.each(["", "const legacy = useRuntimeConfig().resend"])("preserves existing config regardless of detected readers: %s", async (reader) => {
    const legacy = 'resend: { apiKey: process.env.LEGACY_KEY, region: "eu" }'
    const cwd = await app(`await useResend().emails.send(${message})\n${reader}\n`, `runtimeConfig: { ${legacy} },`, "nuxt-resend")
    const run = await runCodemod("resend", { cwd, dryRun: true })
    expect(run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after).toContain(legacy)
  })

  it("preserves dynamic runtime config and reports the declaration it cannot add", async () => {
    const cwd = await app(`await useResend().emails.send(${message})`, "runtimeConfig: getConfig(),", "nuxt-resend")
    const run = await runCodemod("resend", { cwd, dryRun: true })
    const config = run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after
    expect(config).toContain("runtimeConfig: getConfig()")
    expect(config?.match(/runtimeConfig:/g)).toHaveLength(1)
    expect(run.result.followUps).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("Keep runtimeConfig.resend.apiKey declared by hand") })]))
  })

  it("declares the module key inside an existing Resend config object", async () => {
    const cwd = await app(`await useResend().emails.send(${message})`, 'runtimeConfig: { resend: { region: "eu" } },', "nuxt-resend")
    const run = await runCodemod("resend", { cwd, dryRun: true })
    const config = run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after
    expect(config).toContain('region: "eu"')
    expect(config).toContain('apiKey: ""')
    expect(config?.match(/resend:/g)).toHaveLength(1)
  })
})

describe("resend credential inference", () => {
  it.each([
    `const config = useRuntimeConfig()\nfunction send(config) { return new Resend(config.apiKey).emails.send(${message}) }`,
    `const config = useRuntimeConfig()\n{ const config = other; new Resend(config.apiKey).emails.send(${message}) }`,
    `function other() { const config = useRuntimeConfig() }\nfunction send(config) { return new Resend(config.apiKey).emails.send(${message}) }`,
    `function send(useRuntimeConfig) { return new Resend(useRuntimeConfig().apiKey).emails.send(${message}) }`,
    `import { useRuntimeConfig } from "other-config"\nnew Resend(useRuntimeConfig().apiKey).emails.send(${message})`,
    `function send(process) { return new Resend(process.env.PARAM_KEY).emails.send(${message}) }`,
    `let config = useRuntimeConfig()\nconfig = other\nnew Resend(config.apiKey).emails.send(${message})`,
  ])("reports unknown sources instead of guessing from identifier names: %s", async (source) => {
    const cwd = await app(`import { Resend } from "resend"\n${source}\n`)
    const run = await runCodemod("resend", { cwd, dryRun: true })
    const config = run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after
    expect(config).not.toContain("NUXT_API_KEY")
    expect(config).not.toContain("PARAM_KEY")
    expect(run.result.followUps).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("reads its API key from an expression") })]))
  })

  it.each([
    `new Resend(useRuntimeConfig().apiKey).emails.send(${message})`,
    `const config = useRuntimeConfig()\nnew Resend(config.apiKey).emails.send(${message})`,
    `import { useRuntimeConfig as getConfig } from "#imports"\nconst config = getConfig()\nnew Resend(config.apiKey).emails.send(${message})`,
  ])("follows proven runtime config bindings: %s", async (source) => {
    const cwd = await app(`import { Resend } from "resend"\n${source}\n`, "runtimeConfig: { apiKey: process.env.MAIL_KEY },")
    const run = await runCodemod("resend", { cwd, dryRun: true })
    const config = run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after
    expect(config).toContain('env.source(["NUXT_API_KEY", "MAIL_KEY"])')
    expect(run.result.followUps).toEqual([])
  })

  describe.each(["readSecret()", "env.RESEND_KEY"])("unknown config credential %s", (expression) => {
    it.each([
      [`await useResend().emails.send(${message})`, `resend: { apiKey: ${expression} },`, "resend.apiKey"],
      [`await useResend().emails.send(${message})`, `runtimeConfig: { resend: { apiKey: ${expression} } },`, "runtimeConfig.resend.apiKey"],
      [`import { Resend } from "resend"\nawait new Resend(useRuntimeConfig().mailKey).emails.send(${message})`, `runtimeConfig: { mailKey: ${expression} },`, "runtimeConfig.mailKey"],
    ])("reports manual credential migration: %s", async (source, options, path) => {
      const cwd = await app(source, options, "nuxt-resend")
      const run = await runCodemod("resend", { cwd, dryRun: true })
      expect(run.result.followUps).toEqual(expect.arrayContaining([expect.objectContaining({
        file: "nuxt.config.ts",
        message: expect.stringContaining(`at ${path} could not be read statically`),
      })]))
    })
  })
})

it("reports clients whose different credential sources would share one Email key", async () => {
  const cwd = await app(`${sdkSend}const second = new Resend(process.env.SECOND_ACCOUNT_KEY)\nawait second.emails.send(${message})\n`)
  const run = await runCodemod("resend", { cwd, dryRun: true })
  expect(run.result.followUps).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("different API-key sources") })]))
})

it("discovers an aliased SDK constructor", async () => {
  const cwd = await app(`import { Resend as ResendClient } from "resend"\nawait new ResendClient(process.env.RESEND_API_KEY).emails.send(${message})\n`)
  const detected = await detectCodemods(cwd)
  expect(detected.some(entry => entry.codemod.name === "resend")).toBe(true)
  const run = await runCodemod("resend", { cwd, dryRun: true })
  expect(run.result.edits.find(edit => edit.path === "server/mail.ts")?.after).toContain(`await email.send(${message})`)
})

it("does not discover a shadowed SDK constructor", async () => {
  const cwd = await app(`import { Resend } from "resend"\nfunction other(Resend) { return new Resend("other").emails.send(${message}) }\n`)
  const detected = await detectCodemods(cwd)
  expect(detected.some(entry => entry.codemod.name === "resend")).toBe(false)
})

describe.each([
  ["nuxt-resend", "the nuxt-resend module and useResend()"],
  ["resend-sdk", "Resend SDK clients in server code"],
])("resend with %s", (name, label) => {
  it(`migrates ${label}`, async () => {
    const input = join(fixtures, name, "input")
    const run = await runCodemod("resend", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after ?? "(deleted)\n").toMatchFileSnapshot(join(fixtures, name, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, name, "output", "report.txt"))
  })
})

describe.each(["nuxt-resend", "resend"])("resend keeps %s clients", (dependency) => {
  it.each([false, true])("keeps the client when an emails use cannot be rewritten (destructured: %s)", async (destructured) => {
    await mkdir(scratch, { recursive: true })
    const cwd = await mkdtemp(join(scratch, "app-"))
    await mkdir(join(cwd, "server"))
    const client = dependency === "resend" ? "new Resend(process.env.RESEND_API_KEY)" : "useResend()"
    const declaration = destructured ? `const { emails } = ${client}` : `const resend = ${client}`
    const untouched = destructured ? "const send = emails.send" : 'await resend.emails.get("existing-id")'
    const source = `${dependency === "resend" ? 'import { Resend } from "resend"\n' : ""}${declaration}
${untouched}
await ${destructured ? "emails" : "resend.emails"}.send({ from: "from@example.com", to: "to@example.com", subject: "Hello", text: "Hi" })
`
    await writeFile(join(cwd, "server/mail.ts"), source)
    await writeFile(join(cwd, "package.json"), JSON.stringify({ dependencies: { [dependency]: "^1.0.0" } }))
    await writeFile(join(cwd, "nuxt.config.ts"), `export default defineNuxtConfig({ modules: ${dependency === "nuxt-resend" ? '["nuxt-resend"]' : "[]"}, vitehub: { host: "node" } })\n`)

    const run = await runCodemod("resend", { cwd, dryRun: true })
    const mail = run.result.edits.find(edit => edit.path === "server/mail.ts")?.after
    expect(mail).toContain(declaration)
    expect(mail).toContain(untouched)
    expect(mail).toContain("await email.send(")
    const manifest = run.result.edits.find(edit => edit.path === "package.json")?.after
    expect(JSON.parse(manifest!).dependencies).toHaveProperty(dependency)
    if (dependency === "nuxt-resend") {
      expect(run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after).toContain('"nuxt-resend"')
    }
  })
})
