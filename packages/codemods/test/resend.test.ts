import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const scratch = fileURLToPath(new URL("../.tmp/resend-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

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
    await writeFile(join(cwd, "nuxt.config.ts"), `export default defineNuxtConfig({ modules: ${dependency === "nuxt-resend" ? '["nuxt-resend"]' : "[]"}, vitehub: { preset: "node" } })\n`)

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
